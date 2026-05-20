import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { changeNotificationsPath } from "./paths.js";

const defaultScope = "home-banner";
const defaultMinLevel = "P2";
const maxStoredNotificationIds = 2000;
const levelRank = new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2]
]);

export function resolveChangeNotificationConfig(env = process.env, overrides = {}) {
  const webhook = stringOrNull(overrides.webhook ?? env.DINGTALK_WEBHOOK ?? env.CHANGE_NOTIFY_DINGTALK_WEBHOOK);
  const enabled = booleanOption(overrides.enabled ?? env.CHANGE_NOTIFY_ENABLED, Boolean(webhook));
  return {
    enabled,
    channel: "dingtalk",
    webhook,
    secret: stringOrNull(overrides.secret ?? env.DINGTALK_SECRET),
    keyword: stringOrNull(overrides.keyword ?? env.DINGTALK_KEYWORD),
    atMobiles: listOption(overrides.atMobiles ?? env.DINGTALK_AT_MOBILES),
    atAll: booleanOption(overrides.atAll ?? env.DINGTALK_AT_ALL, false),
    scope: stringOrNull(overrides.scope ?? env.CHANGE_NOTIFY_SCOPE) || defaultScope,
    minLevel: normalizeChangeLevel(overrides.minLevel ?? env.CHANGE_NOTIFY_MIN_LEVEL) || defaultMinLevel,
    maxItems: clampInteger(overrides.maxItems ?? env.CHANGE_NOTIFY_MAX_ITEMS, 1, 20, 10),
    bootstrap: stringOrNull(overrides.bootstrap ?? env.CHANGE_NOTIFY_BOOTSTRAP) || "send",
    statePath: overrides.statePath || changeNotificationsPath,
    fetchImpl: overrides.fetchImpl || globalThis.fetch
  };
}

export async function notifyChangeRecords(changes, options = {}) {
  const config = resolveChangeNotificationConfig(options.env || process.env, options);
  if (!config.enabled) {
    return { ok: true, enabled: false, reason: "not-configured" };
  }
  if (!config.webhook) {
    return { ok: false, enabled: true, reason: "missing-webhook" };
  }
  if (typeof config.fetchImpl !== "function") {
    return { ok: false, enabled: true, reason: "fetch-unavailable" };
  }

  const state = await loadNotificationState(config.statePath);
  const matchingChanges = notificationEligibleChanges(changes, config);
  const previousChangeIds = changeIdSet(options.previousChanges || options.previousChangeIds || []);
  const notifiedIds = new Set(state.notifiedIds || []);
  const bootstrapMode = String(config.bootstrap || "skip").toLowerCase();

  if (!state.initializedAt && previousChangeIds.size === 0 && bootstrapMode !== "send") {
    const nextState = updateNotificationState(state, matchingChanges, options.now || new Date());
    await saveNotificationState(nextState, config.statePath);
    return {
      ok: true,
      enabled: true,
      bootstrapped: true,
      sentCount: 0,
      eligibleCount: matchingChanges.length
    };
  }

  const pendingChanges = matchingChanges
    .filter((change) => !notifiedIds.has(change.id))
    .filter((change) => !previousChangeIds.has(change.id));

  if (!pendingChanges.length) {
    const nextState = updateNotificationState(state, matchingChanges, options.now || new Date());
    await saveNotificationState(nextState, config.statePath);
    return {
      ok: true,
      enabled: true,
      sentCount: 0,
      eligibleCount: matchingChanges.length
    };
  }

  const selectedChanges = pendingChanges.slice(0, config.maxItems);
  const previousMatchingChanges = matchingChanges.filter((change) => previousChangeIds.has(change.id));
  const body = buildDingTalkMarkdownMessage(selectedChanges, {
    ...config,
    omittedCount: Math.max(0, pendingChanges.length - selectedChanges.length)
  });
  const result = await postDingTalkMessage(config, body);
  const nextState = updateNotificationState(state, [...previousMatchingChanges, ...selectedChanges], options.now || new Date());
  await saveNotificationState(nextState, config.statePath);

  return {
    ok: true,
    enabled: true,
    channel: config.channel,
    sentCount: selectedChanges.length,
    pendingCount: pendingChanges.length,
    eligibleCount: matchingChanges.length,
    response: result
  };
}

export function notificationEligibleChanges(changes, config = {}) {
  const scope = config.scope || defaultScope;
  const minLevel = normalizeChangeLevel(config.minLevel) || defaultMinLevel;
  const minRank = levelRank.get(minLevel) ?? levelRank.get(defaultMinLevel);

  return (Array.isArray(changes) ? changes : [])
    .filter((change) => change?.id)
    .filter((change) => scope === "all" || change.monitorScope === scope || (scope === defaultScope && isHomeBannerChange(change)))
    .filter((change) => {
      const level = normalizeChangeLevel(change.changeLevel) || defaultMinLevel;
      return (levelRank.get(level) ?? levelRank.get(defaultMinLevel)) <= minRank;
    });
}

export function buildDingTalkMarkdownMessage(changes, options = {}) {
  const keyword = stringOrNull(options.keyword);
  const title = `${keyword ? `${keyword} ` : ""}jietu 首页 Banner 变更`;
  const lines = [
    `### ${title}`,
    "",
    `发现 ${changes.length} 条首页 banner 变更。`,
    ""
  ];

  for (const change of changes) {
    const level = normalizeChangeLevel(change.changeLevel) || defaultMinLevel;
    const location = change.changeLocation || changeLocationLabel(change);
    const types = Array.isArray(change.changeTypes) && change.changeTypes.length
      ? change.changeTypes.join("、")
      : change.changeType || "变更";
    const fromTime = shortDateTime(change.occurredBetween?.from || change.from?.capturedAt);
    const toTime = shortDateTime(change.occurredBetween?.to || change.to?.capturedAt || change.createdAt);
    lines.push(`- **${level}** ${location}：${types}（${fromTime} -> ${toTime}）`);
    if (change.changeLevelReason) {
      lines.push(`  - 原因：${change.changeLevelReason}`);
    }
  }

  if (Number(options.omittedCount || 0) > 0) {
    lines.push("");
    lines.push(`还有 ${Number(options.omittedCount)} 条同批变更未在本条消息展开，请打开 jietu 变更汇总查看。`);
  }

  return {
    msgtype: "markdown",
    markdown: {
      title,
      text: lines.join("\n")
    },
    at: {
      atMobiles: Array.isArray(options.atMobiles) ? options.atMobiles : [],
      isAtAll: Boolean(options.atAll)
    }
  };
}

export function buildDingTalkWebhookUrl(webhook, secret, timestamp = Date.now()) {
  const url = new URL(webhook);
  if (secret) {
    const sign = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}\n${secret}`, "utf8")
      .digest("base64");
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", sign);
  }
  return url.toString();
}

async function postDingTalkMessage(config, body) {
  const url = buildDingTalkWebhookUrl(config.webhook, config.secret);
  const response = await config.fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = parseJsonOrNull(text);
  if (!response.ok) {
    throw new Error(`DingTalk webhook returned HTTP ${response.status}`);
  }
  if (parsed && Number(parsed.errcode || 0) !== 0) {
    throw new Error(`DingTalk webhook returned errcode ${parsed.errcode}: ${parsed.errmsg || ""}`.trim());
  }
  return parsed || { ok: true };
}

async function loadNotificationState(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      version: 1,
      initializedAt: stringOrNull(parsed.initializedAt),
      updatedAt: stringOrNull(parsed.updatedAt),
      notifiedIds: Array.isArray(parsed.notifiedIds)
        ? parsed.notifiedIds.map(stringOrNull).filter(Boolean)
        : []
    };
  } catch {
    return { version: 1, initializedAt: null, updatedAt: null, notifiedIds: [] };
  }
}

async function saveNotificationState(state, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

function updateNotificationState(state, changes, now) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
  const notifiedIds = [...new Set([
    ...(state.notifiedIds || []),
    ...(Array.isArray(changes) ? changes.map((change) => change.id).filter(Boolean) : [])
  ])].slice(-maxStoredNotificationIds);
  return {
    version: 1,
    initializedAt: state.initializedAt || timestamp,
    updatedAt: timestamp,
    notifiedIds
  };
}

function changeIdSet(input) {
  if (input instanceof Set) {
    return new Set([...input].map(stringOrNull).filter(Boolean));
  }
  return new Set((Array.isArray(input) ? input : [])
    .map((item) => typeof item === "string" ? item : item?.id)
    .map(stringOrNull)
    .filter(Boolean));
}

function isHomeBannerChange(change) {
  return change.location?.sectionKey === "banner" ||
    Number(change.location?.bannerIndex || 0) > 0 ||
    /banner/i.test(String(change.changeLocation || ""));
}

function changeLocationLabel(change) {
  const index = Number(change.location?.bannerIndex || change.location?.stateIndex || 0);
  if (index > 0) {
    return `banner区-banner${index}`;
  }
  return change.location?.sectionLabel || change.location?.label || "首页 banner";
}

function normalizeChangeLevel(value) {
  const level = String(value || "").trim().toUpperCase();
  return levelRank.has(level) ? level : null;
}

function shortDateTime(value) {
  if (!value) {
    return "未知时间";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function booleanOption(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function listOption(value) {
  if (Array.isArray(value)) {
    return value.map(stringOrNull).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map(stringOrNull)
    .filter(Boolean);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
