import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { changeNotificationsPath } from "./paths.js";

const defaultScope = "home-banner";
const defaultMinLevel = "P2";
const maxStoredNotificationIds = 2000;
const notificationTimeZone = "Asia/Shanghai";
const shortDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: notificationTimeZone,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});
const levelRank = new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2]
]);
const copy = {
  defaultTitle: "\u4e50\u4e50\u6765\u64ad\u62a5\u4e86\uff01",
  foundPrefix: "\u53d1\u73b0",
  homeBannerChangeSuffix: "\u6761\u9996\u9875 banner \u53d8\u66f4\u3002",
  listSeparator: "\u3001",
  fallbackChangeType: "\u53d8\u66f4",
  reasonLabel: "\u539f\u56e0",
  omittedPrefix: "\u8fd8\u6709",
  omittedSuffix: "\u6761\u540c\u6279\u53d8\u66f4\u672a\u5728\u672c\u6761\u6d88\u606f\u5c55\u5f00\uff0c\u8bf7\u6253\u5f00 jietu \u53d8\u66f4\u6c47\u603b\u67e5\u770b\u3002",
  bannerLocationPrefix: "banner\u533a-banner",
  homeBannerFallback: "\u9996\u9875 banner",
  unknownTime: "\u672a\u77e5\u65f6\u95f4"
};

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
  const state = await loadNotificationState(config.statePath);
  const matchingChanges = notificationEligibleChanges(changes, config);
  const previousChangeIds = changeIdSet(options.previousChanges || options.previousChangeIds || []);
  const notifiedIds = new Set(state.notifiedIds || []);
  const bootstrapMode = String(config.bootstrap || "skip").toLowerCase();
  const recordOnly = Boolean(options.recordOnly || options.sendNotifications === false);

  if (recordOnly) {
    const nextState = updateNotificationState(state, matchingChanges, options.now || new Date());
    await saveNotificationState(nextState, config.statePath);
    return {
      ok: true,
      enabled: config.enabled,
      recordOnly: true,
      sentCount: 0,
      eligibleCount: matchingChanges.length,
      recordedCount: matchingChanges.length
    };
  }

  if (!config.enabled) {
    return { ok: true, enabled: false, reason: "not-configured" };
  }
  if (!config.webhook) {
    return { ok: false, enabled: true, reason: "missing-webhook" };
  }
  if (typeof config.fetchImpl !== "function") {
    return { ok: false, enabled: true, reason: "fetch-unavailable" };
  }

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
  const title = `${keyword ? `${keyword} ` : ""}${copy.defaultTitle}`;
  const lines = [
    `### ${title}`,
    "",
    `${copy.foundPrefix} ${changes.length} ${copy.homeBannerChangeSuffix}`,
    ""
  ];

  for (const change of changes) {
    const level = normalizeChangeLevel(change.changeLevel) || defaultMinLevel;
    const location = change.changeLocation || changeLocationLabel(change);
    const types = Array.isArray(change.changeTypes) && change.changeTypes.length
      ? change.changeTypes.join(copy.listSeparator)
      : change.changeType || copy.fallbackChangeType;
    const fromTime = shortDateTime(change.occurredBetween?.from || change.from?.capturedAt);
    const toTime = shortDateTime(change.occurredBetween?.to || change.to?.capturedAt || change.createdAt);
    lines.push(`- **${level}** ${location}\uff1a${types}\uff08${fromTime} -> ${toTime}\uff09`);
    if (change.changeLevelReason) {
      lines.push(`  - ${copy.reasonLabel}\uff1a${change.changeLevelReason}`);
    }
  }

  if (Number(options.omittedCount || 0) > 0) {
    lines.push("");
    lines.push(`${copy.omittedPrefix} ${Number(options.omittedCount)} ${copy.omittedSuffix}`);
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

export function buildDingTalkBroadcastMessage(options = {}) {
  const title = stringOrNull(options.title) || copy.defaultTitle;
  const text = stringOrNull(options.text);
  if (!text) {
    throw new Error("DingTalk broadcast text is required.");
  }

  const lines = [
    `### ${title}`,
    "",
    text
  ];
  const imageUrl = stringOrNull(options.imageUrl);
  if (imageUrl) {
    lines.push("", `![${title}](${imageUrl})`);
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

export async function sendDingTalkMessage(body, options = {}) {
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

  const response = await postDingTalkMessage(config, body);
  return {
    ok: true,
    enabled: true,
    channel: config.channel,
    response
  };
}

export function assertReadableDingTalkMessage(body) {
  const fields = [
    body?.markdown?.title,
    body?.markdown?.text,
    body?.text?.content
  ].map((value) => String(value || "")).filter(Boolean);
  const badField = fields.find(hasSuspiciousReplacementQuestionMarks);
  if (badField) {
    throw new Error(
      "DingTalk message appears to contain replacement question marks. " +
      "Use UTF-8 source text or base64 input before sending."
    );
  }
  return body;
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
  assertReadableDingTalkMessage(body);
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
    return `${copy.bannerLocationPrefix}${index}`;
  }
  return change.location?.sectionLabel || change.location?.label || copy.homeBannerFallback;
}

function normalizeChangeLevel(value) {
  const level = String(value || "").trim().toUpperCase();
  return levelRank.has(level) ? level : null;
}

function shortDateTime(value) {
  if (!value) {
    return copy.unknownTime;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return formatShortDateTime(date);
}

function formatShortDateTime(date) {
  const parts = Object.fromEntries(shortDateTimeFormatter
    .formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
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

function hasSuspiciousReplacementQuestionMarks(text) {
  return /\?{4,}/.test(String(text || ""));
}
