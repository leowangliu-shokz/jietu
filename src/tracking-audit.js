import fs from "node:fs/promises";
import path from "node:path";
import { trackingAuditPath } from "./paths.js";

const maxRecords = 1200;
const maxEventsPerRecord = 220;
const maxInteractionsPerRecord = 160;
const maxRequestsPerRecord = 220;
const clickEventWindowMs = 2200;
const scrollEventWindowMs = 5000;
const systemEventNames = new Set([
  "gtm.js",
  "gtm.dom",
  "gtm.load",
  "gtm.historychange",
  "gtm.timer",
  "js",
  "config",
  "consent",
  "set"
]);
const clickEventNames = new Set([
  "click",
  "gtm.click",
  "select_content",
  "select_item",
  "view_item",
  "add_to_cart",
  "begin_checkout",
  "login",
  "sign_up",
  "generate_lead"
]);
const scrollEventNames = new Set(["scroll", "gtm.scrolldepth", "scroll_depth"]);
const clickLabelParamKeys = [
  "button_name",
  "buttonName",
  "link_text",
  "linkText",
  "content_name",
  "contentName",
  "item_name",
  "itemName",
  "label",
  "text"
];
const requiredParamsByEvent = new Map([
  ["select_content", ["content_type", "content_name"]],
  ["select_item", ["item_name"]],
  ["add_to_cart", ["item_name"]],
  ["begin_checkout", ["currency", "value"]]
]);

export async function loadTrackingAuditRecords(filePath = trackingAuditPath) {
  const parsed = await readJson(filePath, []);
  return Array.isArray(parsed)
    ? parsed.map(normalizeTrackingAuditRecord).filter(Boolean).sort(compareTrackingRecordsNewestFirst)
    : [];
}

export async function saveTrackingAuditRecords(records, filePath = trackingAuditPath) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeTrackingAuditRecord)
    .filter(Boolean)
    .sort(compareTrackingRecordsNewestFirst)
    .slice(0, maxRecords);
  await writeJson(filePath, normalized);
  return normalized;
}

export async function appendTrackingAuditRecords(records, filePath = trackingAuditPath) {
  const incoming = (Array.isArray(records) ? records : [records])
    .map(normalizeTrackingAuditRecord)
    .filter(Boolean);
  if (!incoming.length) {
    return [];
  }
  const existing = await loadTrackingAuditRecords(filePath);
  const incomingIds = new Set(incoming.map((record) => record.id));
  await saveTrackingAuditRecords([
    ...incoming,
    ...existing.filter((record) => !incomingIds.has(record.id))
  ], filePath);
  return incoming;
}

export function buildTrackingAuditSummary(records = []) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeTrackingAuditRecord)
    .filter(Boolean);
  const issueCount = normalized.reduce((sum, record) => sum + Number(record.issueCount || 0), 0);
  const eventCount = normalized.reduce((sum, record) => sum + Number(record.eventCount || 0), 0);
  const ga4RequestCount = normalized.reduce((sum, record) => sum + Number(record.ga4RequestCount || 0), 0);
  return {
    recordCount: normalized.length,
    issueCount,
    eventCount,
    ga4RequestCount,
    latestRecord: normalized.sort(compareTrackingRecordsNewestFirst)[0] || null
  };
}

export function createTrackingAuditRecordsForSnapshots({
  snapshots = [],
  capture = null,
  relatedTrackingAudits = [],
  auditedAt = new Date().toISOString()
} = {}) {
  const combinedAudit = combineTrackingAudits([
    capture?.trackingAudit,
    ...relatedTrackingAudits
  ]);
  if (!combinedAudit) {
    return [];
  }

  return (Array.isArray(snapshots) ? snapshots : [])
    .map((snapshot) => createTrackingAuditRecord(snapshot, combinedAudit, { auditedAt }))
    .filter(Boolean);
}

export function createTrackingAuditRecord(snapshot, audit, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || !audit || typeof audit !== "object") {
    return null;
  }
  const events = normalizeTrackingEvents(audit.events);
  const requests = normalizeGa4Requests([
    ...(Array.isArray(audit.ga4Requests) ? audit.ga4Requests : []),
    ...(Array.isArray(audit.networkRequests) ? audit.networkRequests : []),
    ...(Array.isArray(audit.network) ? audit.network : [])
  ]);
  const interactions = normalizeTrackingInteractions(audit.interactions);
  const issues = buildTrackingIssues({ events, requests, interactions });
  const auditedAt = cleanText(options.auditedAt || audit.capturedAt || new Date().toISOString());

  return normalizeTrackingAuditRecord({
    id: `${snapshot.id}-tracking`,
    snapshotId: snapshot.id,
    auditedAt,
    capturedAt: snapshot.capturedAt,
    url: snapshot.url,
    requestedUrl: snapshot.requestedUrl,
    finalUrl: snapshot.finalUrl,
    targetId: snapshot.targetId,
    targetLabel: snapshot.targetLabel,
    displayUrl: snapshot.displayUrl,
    platform: snapshot.platform,
    devicePresetId: snapshot.devicePresetId,
    deviceProfileId: snapshot.deviceProfileId,
    capturePlanId: snapshot.capturePlanId,
    title: snapshot.title,
    eventCount: events.length,
    ga4RequestCount: requests.length,
    interactionCount: interactions.length,
    issueCount: issues.length,
    events: events.slice(0, maxEventsPerRecord),
    ga4Requests: requests.slice(0, maxRequestsPerRecord),
    interactions: interactions.slice(0, maxInteractionsPerRecord),
    issues
  });
}

export function buildTrackingIssues({ events = [], requests = [], interactions = [] } = {}) {
  const issues = [];
  const businessEvents = events.filter(isBusinessTrackingEvent);
  const clickEvents = businessEvents.filter(isClickLikeEvent);
  const scrollEvents = businessEvents.filter(isScrollLikeEvent);

  for (const event of businessEvents) {
    if (!event.name) {
      issues.push({
        level: "P1",
        type: "missing-event-name",
        message: "埋点事件缺少 GA4 event name。",
        source: event.source,
        context: eventLabel(event)
      });
    }
    for (const paramName of requiredParamsForEvent(event)) {
      if (!hasParam(event.parameters, paramName)) {
        issues.push({
          level: "P1",
          type: "required-param-missing",
          message: `${event.name} 缺少 ${paramName} 参数。`,
          eventName: event.name,
          parameterName: paramName,
          source: event.source,
          context: eventLabel(event)
        });
      }
    }
    if (isClickLikeEvent(event) && !eventLabelParam(event)) {
      issues.push({
        level: "P1",
        type: "click-label-missing",
        message: `${event.name || "点击事件"} 缺少 button_name/link_text/content_name 等可读点击标签。`,
        eventName: event.name,
        source: event.source,
        context: eventLabel(event)
      });
    }
  }

  for (const interaction of interactions.filter((item) => item.type === "click")) {
    const expected = expectedClickLabel(interaction);
    if (!expected || isIgnoredClickLabel(expected)) {
      continue;
    }
    const relatedEvents = clickEvents.filter((event) => eventMatchesInteraction(event, interaction, clickEventWindowMs));
    if (!relatedEvents.length) {
      issues.push({
        level: "P2",
        type: "click-without-event",
        message: `点击 ${expected} 后未捕获到对应 dataLayer/GA4 事件。`,
        expected,
        interactionId: interaction.id,
        context: interactionContext(interaction)
      });
      continue;
    }

    for (const event of relatedEvents) {
      const actual = eventLabelParam(event);
      if (!actual) {
        continue;
      }
      const before = normalizeComparableLabel(interaction.labelBefore);
      const after = normalizeComparableLabel(interaction.labelAfter);
      const normalizedActual = normalizeComparableLabel(actual);
      const expectedAfter = after || before;
      if (expectedAfter && normalizedActual && normalizedActual !== expectedAfter) {
        const staleBefore = before && normalizedActual === before && after && before !== after;
        issues.push({
          level: staleBefore ? "P0" : "P1",
          type: "button-label-mismatch",
          message: staleBefore
            ? `按钮点击后显示为 ${interaction.labelAfter}，但埋点仍上报 ${actual}。`
            : `按钮文案与埋点标签不一致：页面 ${expected}，埋点 ${actual}。`,
          expected,
          actual,
          eventName: event.name,
          interactionId: interaction.id,
          source: event.source,
          context: interactionContext(interaction)
        });
      }
    }
  }

  for (const interaction of interactions.filter((item) => item.type === "scroll")) {
    const depth = Number(interaction.depthPercent || 0);
    if (depth < 50) {
      continue;
    }
    const relatedEvents = scrollEvents.filter((event) => eventMatchesInteraction(event, interaction, scrollEventWindowMs));
    if (!relatedEvents.length) {
      issues.push({
        level: "P2",
        type: "scroll-without-event",
        message: `页面滚动到 ${Math.round(depth)}% 深度后未捕获到 scroll/scroll_depth 埋点。`,
        expected: `${Math.round(depth)}%`,
        interactionId: interaction.id,
        context: interactionContext(interaction)
      });
    }
  }

  for (const request of requests.filter((item) => item.name)) {
    if (!businessEvents.some((event) => normalizeEventName(event.name) === normalizeEventName(request.name))) {
      issues.push({
        level: "P2",
        type: "ga4-request-without-event",
        message: `发现 GA4 请求 ${request.name}，但没有匹配的 dataLayer/gtag 事件。`,
        eventName: request.name,
        source: request.source,
        context: request.url
      });
    }
  }

  for (const event of businessEvents.filter((item) => item.name)) {
    if (!requests.some((request) => normalizeEventName(request.name) === normalizeEventName(event.name))) {
      issues.push({
        level: "P2",
        type: "event-without-ga4-request",
        message: `捕获到 ${event.name} 事件，但没有匹配的 GA4 请求。`,
        eventName: event.name,
        source: event.source,
        context: eventLabel(event)
      });
    }
  }

  return dedupeIssues(issues).slice(0, 80);
}

export function normalizeTrackingAuditRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const id = cleanText(record.id);
  if (!id) {
    return null;
  }
  const events = normalizeTrackingEvents(record.events).slice(0, maxEventsPerRecord);
  const ga4Requests = normalizeGa4Requests(record.ga4Requests).slice(0, maxRequestsPerRecord);
  const interactions = normalizeTrackingInteractions(record.interactions).slice(0, maxInteractionsPerRecord);
  const issues = (Array.isArray(record.issues) ? record.issues : [])
    .map(normalizeTrackingIssue)
    .filter(Boolean)
    .slice(0, 80);
  return {
    id,
    snapshotId: cleanText(record.snapshotId),
    auditedAt: cleanText(record.auditedAt || record.checkedAt || record.capturedAt),
    capturedAt: cleanText(record.capturedAt),
    url: cleanText(record.url),
    requestedUrl: cleanText(record.requestedUrl),
    finalUrl: cleanText(record.finalUrl),
    targetId: cleanText(record.targetId),
    targetLabel: cleanText(record.targetLabel),
    displayUrl: cleanText(record.displayUrl || record.targetLabel || record.finalUrl || record.url),
    platform: normalizePlatform(record.platform),
    devicePresetId: cleanText(record.devicePresetId),
    deviceProfileId: cleanText(record.deviceProfileId),
    capturePlanId: cleanText(record.capturePlanId),
    title: cleanText(record.title),
    eventCount: nonNegativeInteger(record.eventCount ?? events.length),
    ga4RequestCount: nonNegativeInteger(record.ga4RequestCount ?? ga4Requests.length),
    interactionCount: nonNegativeInteger(record.interactionCount ?? interactions.length),
    issueCount: nonNegativeInteger(record.issueCount ?? issues.length),
    events,
    ga4Requests,
    interactions,
    issues
  };
}

function combineTrackingAudits(audits) {
  const usable = (Array.isArray(audits) ? audits : [audits])
    .filter((audit) => audit && typeof audit === "object");
  if (!usable.length) {
    return null;
  }
  return {
    events: usable.flatMap((audit) => Array.isArray(audit.events) ? audit.events : []),
    interactions: usable.flatMap((audit) => Array.isArray(audit.interactions) ? audit.interactions : []),
    ga4Requests: usable.flatMap((audit) => [
      ...(Array.isArray(audit.ga4Requests) ? audit.ga4Requests : []),
      ...(Array.isArray(audit.networkRequests) ? audit.networkRequests : []),
      ...(Array.isArray(audit.network) ? audit.network : [])
    ])
  };
}

function normalizeTrackingEvents(events) {
  return (Array.isArray(events) ? events : [])
    .map(normalizeTrackingEvent)
    .filter(Boolean)
    .sort(compareByTimeThenName);
}

function normalizeTrackingEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const source = cleanText(event.source || "dataLayer");
  const command = cleanText(event.command);
  const rawParameters = objectFrom(event.parameters || event.payload || event.params);
  const name = cleanText(event.name || event.eventName || event.event || rawParameters.event || rawParameters.event_name || rawParameters.en || gtagEventName(event));
  const parameters = normalizeParameters({
    ...rawParameters,
    ...(event.args && command === "event" && typeof event.args[2] === "object" ? event.args[2] : {})
  });
  return {
    id: cleanText(event.id),
    source,
    name,
    command,
    parameters,
    interactionId: cleanText(event.interactionId),
    timestamp: nonNegativeInteger(event.timestamp || event.time || 0),
    url: cleanText(event.url),
    pagePath: cleanText(event.pagePath || parameters.page_path || parameters.page_location),
    label: eventLabelParam({ parameters })
  };
}

function normalizeGa4Requests(requests) {
  return (Array.isArray(requests) ? requests : [])
    .map(normalizeGa4Request)
    .filter(Boolean)
    .sort(compareByTimeThenName);
}

function normalizeGa4Request(request) {
  if (!request || typeof request !== "object") {
    return null;
  }
  const url = cleanText(request.url);
  if (!isGa4Url(url)) {
    return null;
  }
  const parameters = normalizeParameters({
    ...queryParamsFromUrl(url),
    ...queryParamsFromBody(request.postData || request.body)
  });
  const name = cleanText(request.name || request.eventName || parameters.en || parameters.event || parameters.event_name);
  return {
    id: cleanText(request.id || request.requestId),
    source: cleanText(request.source || request.transport || "ga4-request"),
    method: cleanText(request.method || "GET"),
    name,
    parameters,
    timestamp: nonNegativeInteger(request.timestamp || request.time || 0),
    url,
    postData: cleanText(request.postData || request.body).slice(0, 1500)
  };
}

function normalizeTrackingInteractions(interactions) {
  return (Array.isArray(interactions) ? interactions : [])
    .map(normalizeTrackingInteraction)
    .filter(Boolean)
    .sort(compareByTimeThenName);
}

function normalizeTrackingInteraction(interaction) {
  if (!interaction || typeof interaction !== "object") {
    return null;
  }
  const type = cleanText(interaction.type);
  if (!["click", "scroll"].includes(type)) {
    return null;
  }
  return {
    id: cleanText(interaction.id),
    type,
    timestamp: nonNegativeInteger(interaction.timestamp || interaction.time || 0),
    labelBefore: cleanText(interaction.labelBefore || interaction.label),
    labelAfter: cleanText(interaction.labelAfter),
    tagName: cleanText(interaction.tagName).toLowerCase(),
    selector: cleanText(interaction.selector).slice(0, 240),
    href: cleanText(interaction.href).slice(0, 1000),
    ariaExpandedBefore: cleanText(interaction.ariaExpandedBefore),
    ariaExpandedAfter: cleanText(interaction.ariaExpandedAfter),
    scrollY: nonNegativeInteger(interaction.scrollY),
    depthPercent: nonNegativeInteger(interaction.depthPercent),
    url: cleanText(interaction.url)
  };
}

function normalizeTrackingIssue(issue) {
  if (!issue || typeof issue !== "object") {
    return null;
  }
  return {
    level: /^P[0-2]$/.test(issue.level || "") ? issue.level : "P2",
    type: cleanText(issue.type || "tracking-issue"),
    message: cleanText(issue.message, 600),
    eventName: cleanText(issue.eventName),
    parameterName: cleanText(issue.parameterName),
    expected: cleanText(issue.expected),
    actual: cleanText(issue.actual),
    source: cleanText(issue.source),
    interactionId: cleanText(issue.interactionId),
    context: cleanText(issue.context, 1000)
  };
}

function isBusinessTrackingEvent(event) {
  const name = normalizeEventName(event.name);
  if (!name) {
    return Object.keys(event.parameters || {}).some((key) =>
      /button|content|item|link|scroll|click/i.test(key)
    );
  }
  return !systemEventNames.has(name);
}

function isClickLikeEvent(event) {
  const name = normalizeEventName(event.name);
  if (clickEventNames.has(name)) {
    return true;
  }
  return /click|select|cart|checkout|login|signup|sign_up|lead/i.test(name);
}

function isScrollLikeEvent(event) {
  const name = normalizeEventName(event.name);
  if (scrollEventNames.has(name)) {
    return true;
  }
  return /scroll/i.test(name);
}

function eventMatchesInteraction(event, interaction, windowMs) {
  if (event.interactionId && interaction.id && event.interactionId === interaction.id) {
    return true;
  }
  const eventTime = Number(event.timestamp || 0);
  const interactionTime = Number(interaction.timestamp || 0);
  return eventTime > 0 &&
    interactionTime > 0 &&
    eventTime >= interactionTime &&
    eventTime - interactionTime <= windowMs;
}

function requiredParamsForEvent(event) {
  const name = normalizeEventName(event.name);
  const required = requiredParamsByEvent.get(name) || [];
  return isClickLikeEvent(event)
    ? [...new Set([...required, "click_label"])]
    : required;
}

function hasParam(parameters, key) {
  if (key === "click_label") {
    return Boolean(eventLabelParam({ parameters }));
  }
  return Object.hasOwn(parameters || {}, key) && cleanText(parameters[key]);
}

function expectedClickLabel(interaction) {
  return cleanText(interaction.labelAfter || interaction.labelBefore);
}

function eventLabelParam(event) {
  const parameters = event?.parameters || {};
  for (const key of clickLabelParamKeys) {
    const value = cleanText(parameters[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function eventLabel(event) {
  return [
    event.name,
    eventLabelParam(event),
    event.pagePath || event.url
  ].filter(Boolean).join(" / ");
}

function interactionContext(interaction) {
  return [
    interaction.selector,
    interaction.href,
    interaction.url
  ].filter(Boolean).join(" / ");
}

function isIgnoredClickLabel(label) {
  return /^(close|dismiss|×|x|skip|feedback)$/i.test(cleanText(label));
}

function normalizeComparableLabel(value) {
  return cleanText(value)
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/[\u25b2\u25bc\u25be\u25bf\u2228\u203a\u00bb<>^⌃⌄]+/g, "")
    .trim()
    .toLowerCase();
}

function normalizeEventName(value) {
  return cleanText(value).trim().toLowerCase();
}

function gtagEventName(event) {
  const args = Array.isArray(event.args) ? event.args : [];
  return cleanText(args[0]) === "event" ? cleanText(args[1]) : "";
}

function objectFrom(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeParameters(parameters) {
  const next = {};
  for (const [key, value] of Object.entries(objectFrom(parameters))) {
    const cleanKey = cleanText(key);
    if (!cleanKey) {
      continue;
    }
    const normalizedKey = cleanKey.startsWith("ep.") || cleanKey.startsWith("epn.")
      ? cleanKey.slice(cleanKey.indexOf(".") + 1)
      : cleanKey;
    next[normalizedKey] = typeof value === "object"
      ? JSON.stringify(value).slice(0, 1000)
      : cleanText(value, 1000);
  }
  return next;
}

function queryParamsFromUrl(url) {
  try {
    return Object.fromEntries(new URL(url).searchParams.entries());
  } catch {
    return {};
  }
}

function queryParamsFromBody(body) {
  const raw = cleanText(body, 5000);
  if (!raw) {
    return {};
  }
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  try {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return {};
  }
}

function isGa4Url(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    return /(^|\.)google-analytics\.com$/i.test(host) &&
      (/\/g\/collect$|\/collect$|\/mp\/collect$/i.test(parsed.pathname) || parsed.searchParams.has("en"));
  } catch {
    return false;
  }
}

function dedupeIssues(issues) {
  const seen = new Set();
  const result = [];
  for (const issue of issues.map(normalizeTrackingIssue).filter(Boolean)) {
    const key = [
      issue.level,
      issue.type,
      issue.eventName,
      issue.parameterName,
      issue.expected,
      issue.actual,
      issue.interactionId,
      issue.context
    ].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(issue);
    }
  }
  return result.sort(compareIssues);
}

function compareIssues(a, b) {
  return issueWeight(a.level) - issueWeight(b.level) ||
    String(a.type).localeCompare(String(b.type));
}

function issueWeight(level) {
  if (level === "P0") return 0;
  if (level === "P1") return 1;
  return 2;
}

function compareTrackingRecordsNewestFirst(a, b) {
  return String(b.auditedAt || b.capturedAt || "").localeCompare(String(a.auditedAt || a.capturedAt || ""));
}

function compareByTimeThenName(a, b) {
  return Number(a.timestamp || 0) - Number(b.timestamp || 0) ||
    String(a.name || a.type || "").localeCompare(String(b.name || b.type || ""));
}

function normalizePlatform(value) {
  return value === "mobile" ? "mobile" : "pc";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
