import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { seoChangesPath, seoSnapshotsPath } from "./paths.js";

const trackedSeoFields = [
  { key: "title", label: "Title", level: "P1", required: true },
  { key: "metaDescription", label: "Meta description", level: "P1", required: true },
  { key: "metaKeywords", label: "Meta keywords", level: "P1" },
  { key: "canonical", label: "Canonical", level: "P1", required: true },
  { key: "canonicalStatus", label: "Canonical status", level: "P1" },
  { key: "hreflangs", label: "Hreflang", level: "P1" },
  { key: "robots", label: "Robots", level: "P1" },
  { key: "language", label: "HTML language", level: "P2" },
  { key: "h1", label: "H1", level: "P1", required: true },
  { key: "headings", label: "Headings", level: "P1" },
  { key: "tableHeaders", label: "Table headers", level: "P1" },
  { key: "navItems", label: "Navigation labels", level: "P1" },
  { key: "keywordCandidates", label: "Keyword list", level: "P1" },
  { key: "jsonLdTypes", label: "Structured data", level: "P1" },
  { key: "openGraphTitle", label: "Open Graph title", level: "P2" },
  { key: "openGraphDescription", label: "Open Graph description", level: "P2" },
  { key: "imageAltMissingCount", label: "Images missing alt", level: "P2" },
  { key: "linkCounts", label: "Link counts", level: "P2" }
];

export async function loadSeoSnapshots(filePath = seoSnapshotsPath) {
  const parsed = await readJson(filePath, []);
  return Array.isArray(parsed)
    ? parsed.map(normalizeSeoSnapshotRecord).filter(Boolean).sort(compareSeoRecordsNewestFirst)
    : [];
}

export async function saveSeoSnapshots(snapshots, filePath = seoSnapshotsPath) {
  await writeJson(filePath, (Array.isArray(snapshots) ? snapshots : []).map(normalizeSeoSnapshotRecord).filter(Boolean));
  return snapshots;
}

export async function appendSeoSnapshots(nextSnapshots, filePath = seoSnapshotsPath) {
  const incoming = (Array.isArray(nextSnapshots) ? nextSnapshots : [nextSnapshots])
    .map(normalizeSeoSnapshotRecord)
    .filter(Boolean);
  if (!incoming.length) {
    return [];
  }

  const existing = await loadSeoSnapshots(filePath);
  const incomingIds = new Set(incoming.map((snapshot) => snapshot.id));
  const merged = [
    ...incoming,
    ...existing.filter((snapshot) => !incomingIds.has(snapshot.id))
  ];
  await saveSeoSnapshots(merged, filePath);
  return incoming;
}

export async function loadSeoChanges(filePath = seoChangesPath) {
  const parsed = await readJson(filePath, []);
  return Array.isArray(parsed)
    ? parsed.filter((change) => change && typeof change === "object").sort(compareSeoRecordsNewestFirst)
    : [];
}

export async function saveSeoChanges(changes, filePath = seoChangesPath) {
  await writeJson(filePath, Array.isArray(changes) ? changes : []);
  return changes;
}

export async function rebuildSeoChanges(options = {}) {
  const snapshots = options.seoSnapshots || await loadSeoSnapshots(options.seoSnapshotsFilePath || seoSnapshotsPath);
  const changes = compareSeoSnapshots(snapshots);
  await saveSeoChanges(changes, options.seoChangesFilePath || seoChangesPath);
  return changes;
}

export async function deleteSeoSnapshotsForSnapshotIds(snapshotIds, options = {}) {
  const deleteSet = new Set(
    (Array.isArray(snapshotIds) ? snapshotIds : [snapshotIds])
      .map((snapshotId) => String(snapshotId || "").trim())
      .filter(Boolean)
  );
  if (!deleteSet.size) {
    return { ok: true, deletedCount: 0, changeRefresh: { ok: true, count: 0 } };
  }

  const filePath = options.seoSnapshotsFilePath || seoSnapshotsPath;
  const snapshots = await loadSeoSnapshots(filePath);
  const remaining = snapshots.filter((snapshot) => !deleteSet.has(snapshot.snapshotId));
  const deletedCount = snapshots.length - remaining.length;
  if (deletedCount > 0) {
    await saveSeoSnapshots(remaining, filePath);
  }
  const changes = await rebuildSeoChanges({
    seoSnapshots: remaining,
    seoChangesFilePath: options.seoChangesFilePath || seoChangesPath
  });
  return {
    ok: true,
    deletedCount,
    changeRefresh: {
      ok: true,
      count: changes.length
    }
  };
}

export function buildSeoSummary(snapshots = [], changes = []) {
  const normalizedSnapshots = (Array.isArray(snapshots) ? snapshots : [])
    .map(normalizeSeoSnapshotRecord)
    .filter(Boolean)
    .sort(compareSeoRecordsNewestFirst);
  const normalizedChanges = (Array.isArray(changes) ? changes : [])
    .filter((change) => change && typeof change === "object")
    .sort(compareSeoRecordsNewestFirst);

  return {
    snapshotCount: normalizedSnapshots.length,
    changeCount: normalizedChanges.length,
    issueCount: normalizedSnapshots.reduce((sum, snapshot) => sum + Number(snapshot.issueCount || 0), 0),
    criticalIssueCount: normalizedSnapshots.reduce((sum, snapshot) =>
      sum + snapshot.issues.filter((issue) => issue.level === "P0").length, 0),
    latestSnapshot: normalizedSnapshots[0] || null,
    recentIssues: normalizedSnapshots.flatMap((snapshot) =>
      snapshot.issues.map((issue) => ({
        ...issue,
        snapshotId: snapshot.snapshotId,
        capturedAt: snapshot.capturedAt,
        url: snapshot.url,
        finalUrl: snapshot.finalUrl,
        displayUrl: snapshot.displayUrl,
        targetId: snapshot.targetId,
        platform: snapshot.platform
      }))
    ).slice(0, 12),
    recentChanges: normalizedChanges.slice(0, 6)
  };
}

export function createSeoSnapshotRecord({ snapshot, seoSnapshot } = {}) {
  if (!snapshot || typeof snapshot !== "object" || !seoSnapshot || typeof seoSnapshot !== "object") {
    return null;
  }

  return normalizeSeoSnapshotRecord({
    id: `${snapshot.id}-seo`,
    snapshotId: snapshot.id,
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
    content: seoSnapshot
  });
}

export function compareSeoSnapshots(snapshots = []) {
  const items = (Array.isArray(snapshots) ? snapshots : [])
    .map(normalizeSeoSnapshotRecord)
    .filter(Boolean)
    .filter((snapshot) => snapshot.capturedAt && (snapshot.finalUrl || snapshot.url || snapshot.targetId))
    .sort((a, b) =>
      timestamp(a.capturedAt) - timestamp(b.capturedAt) ||
      String(a.id).localeCompare(String(b.id))
    );
  const previousByKey = new Map();
  const changes = [];

  for (const snapshot of items) {
    const key = seoComparisonKey(snapshot);
    const previous = previousByKey.get(key);
    if (previous) {
      const change = compareSeoSnapshotPair(previous, snapshot);
      if (change) {
        changes.push(change);
      }
    }
    previousByKey.set(key, snapshot);
  }

  return changes.sort(compareSeoRecordsNewestFirst);
}

export function compareSeoSnapshotPair(from, to) {
  const before = normalizeSeoSnapshotRecord(from);
  const after = normalizeSeoSnapshotRecord(to);
  if (!before || !after) {
    return null;
  }

  const fields = [];
  for (const field of trackedSeoFields) {
    const beforeValue = seoFieldValue(before, field.key);
    const afterValue = seoFieldValue(after, field.key);
    if (sameComparableValue(beforeValue, afterValue)) {
      continue;
    }
    fields.push({
      field: field.key,
      label: field.label,
      before: displaySeoValue(beforeValue),
      after: displaySeoValue(afterValue),
      level: seoFieldLevel(field, beforeValue, afterValue)
    });
  }

  if (!fields.length) {
    return null;
  }

  const changeLevel = highestSeoLevel(fields);
  return {
    id: hashJson({
      from: before.id,
      to: after.id,
      fields: fields.map((field) => field.field)
    }),
    type: "seo",
    changeType: "seo",
    changeTypes: [...new Set(fields.map((field) => `${field.label} changed`))],
    changeLevel,
    changeLevelReason: seoChangeLevelReason(changeLevel, fields),
    createdAt: after.capturedAt,
    occurredBetween: {
      from: before.capturedAt,
      to: after.capturedAt
    },
    location: seoLocation(after),
    from: seoSnapshotReference(before),
    to: seoSnapshotReference(after),
    seoChange: {
      fields,
      summary: seoChangeSummary(fields)
    },
    fields
  };
}

export function normalizeSeoSnapshotRecord(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const content = input.content && typeof input.content === "object" ? input.content : input;
  const headings = normalizeHeadings(content.headings);
  const h1 = normalizeTextList(content.h1 || headings.filter((heading) => heading.level === "h1").map((heading) => heading.text));
  const meta = content.meta && typeof content.meta === "object" ? content.meta : {};
  const openGraph = content.openGraph && typeof content.openGraph === "object" ? content.openGraph : {};
  const twitter = content.twitter && typeof content.twitter === "object" ? content.twitter : {};
  const imageAlt = content.imageAlt && typeof content.imageAlt === "object" ? content.imageAlt : {};
  const linkCounts = content.linkCounts && typeof content.linkCounts === "object" ? content.linkCounts : {};
  const hreflangChecked = Object.hasOwn(content, "hreflangChecked")
    ? Boolean(content.hreflangChecked)
    : Object.hasOwn(content, "hreflangs") || Object.hasOwn(content, "hreflang");
  const metaKeywords = cleanText(content.metaKeywords ?? meta.keywords);
  const record = {
    id: cleanText(input.id),
    snapshotId: cleanText(input.snapshotId),
    capturedAt: normalizeIso(input.capturedAt),
    url: cleanText(input.url),
    requestedUrl: cleanText(input.requestedUrl),
    finalUrl: cleanText(input.finalUrl),
    targetId: cleanText(input.targetId),
    targetLabel: cleanText(input.targetLabel),
    displayUrl: cleanText(input.displayUrl),
    platform: normalizedPlatform(input.platform),
    devicePresetId: cleanText(input.devicePresetId),
    deviceProfileId: cleanText(input.deviceProfileId),
    capturePlanId: cleanText(input.capturePlanId),
    title: cleanText(content.title),
    metaDescription: cleanText(content.metaDescription ?? meta.description),
    metaKeywords,
    canonical: cleanText(content.canonical),
    canonicalStatus: normalizeUrlStatus(content.canonicalStatus),
    robots: cleanText(content.robots ?? meta.robots),
    viewport: cleanText(content.viewport ?? meta.viewport),
    language: cleanText(content.language),
    h1,
    headings,
    tableHeaders: normalizeTextList(content.tableHeaders),
    navItems: normalizeTextList(content.navItems),
    keywordCandidates: normalizeTextList([
      ...splitKeywords(metaKeywords),
      ...(Array.isArray(content.keywordCandidates) ? content.keywordCandidates : [])
    ]),
    openGraph: {
      title: cleanText(openGraph.title),
      description: cleanText(openGraph.description),
      image: cleanText(openGraph.image),
      url: cleanText(openGraph.url),
      type: cleanText(openGraph.type)
    },
    twitter: {
      title: cleanText(twitter.title),
      description: cleanText(twitter.description),
      image: cleanText(twitter.image),
      card: cleanText(twitter.card)
    },
    jsonLdTypes: normalizeTextList(content.jsonLdTypes),
    hreflangs: normalizeHreflangs(content.hreflangs),
    hreflangChecked,
    technicalNotes: normalizeTextList(content.technicalNotes),
    imageAlt: {
      total: nonNegativeInteger(imageAlt.total),
      missing: nonNegativeInteger(imageAlt.missing)
    },
    linkCounts: {
      total: nonNegativeInteger(linkCounts.total),
      internal: nonNegativeInteger(linkCounts.internal),
      external: nonNegativeInteger(linkCounts.external)
    }
  };

  if (!record.id) {
    record.id = hashJson({
      snapshotId: record.snapshotId,
      capturedAt: record.capturedAt,
      url: record.finalUrl || record.url,
      targetId: record.targetId,
      platform: record.platform,
      title: record.title
    });
  }

  record.issues = buildSeoIssues(record);
  record.issueCount = record.issues.length;
  record.highestIssueLevel = record.issues.length ? highestSeoLevel(record.issues) : "";

  return record;
}

export function buildSeoIssues(snapshot = {}) {
  const record = snapshot && typeof snapshot === "object" ? snapshot : {};
  const issues = [];
  const title = cleanText(record.title);
  const canonical = cleanText(record.canonical);
  const canonicalStatus = normalizeUrlStatus(record.canonicalStatus);
  const robots = cleanText(record.robots);

  if (containsNoindex(robots)) {
    issues.push(seoIssue(record, {
      code: "robots-noindex",
      field: "robots",
      level: "P0",
      title: "Page is marked noindex",
      message: "Robots meta contains noindex.",
      detail: robots
    }));
  }

  if (!canonical) {
    issues.push(seoIssue(record, {
      code: "canonical-missing",
      field: "canonical",
      level: "P0",
      title: "Canonical is missing",
      message: "Search engines cannot see a canonical target for this page."
    }));
  } else if (Number(canonicalStatus.status || 0) >= 400) {
    issues.push(seoIssue(record, {
      code: "canonical-http-error",
      field: "canonical",
      level: "P0",
      title: "Canonical target is not reachable",
      message: `Canonical returns HTTP ${canonicalStatus.status}.`,
      detail: canonicalStatus.finalUrl || canonical,
      expected: "Canonical should point to a live 2xx/3xx URL."
    }));
  }

  const repeatedTitle = repeatedLeadingTitlePhrase(title);
  if (repeatedTitle) {
    issues.push(seoIssue(record, {
      code: "title-leading-duplicate",
      field: "title",
      level: "P1",
      title: "Title starts with duplicated text",
      message: "The document title appears to repeat the page name at the beginning.",
      detail: title,
      expected: "Keep one clean page title and one SEO title, not a concatenated duplicate."
    }));
  }

  const missingHreflangs = record.hreflangChecked ? missingExpectedHreflangs(record) : [];
  if (missingHreflangs.length) {
    issues.push(seoIssue(record, {
      code: "hreflang-missing-region-pair",
      field: "hreflangs",
      level: "P1",
      title: "US/CA hreflang pair is missing",
      message: `Missing hreflang: ${missingHreflangs.join(", ")}.`,
      detail: hreflangSummary(record.hreflangs),
      expected: "Include en-US and en-CA alternates for paired Shokz regional pages."
    }));
  }

  const todoNotes = normalizeTextList(record.technicalNotes).filter((note) => /\bTODO\b/i.test(note));
  if (todoNotes.length) {
    issues.push(seoIssue(record, {
      code: "technical-todo-comment",
      field: "technicalNotes",
      level: "P2",
      title: "Development TODO comment remains",
      message: "Inline page script still contains a TODO comment.",
      detail: todoNotes.slice(0, 2).join(" | "),
      expected: "Remove temporary development comments before release."
    }));
  }

  return issues;
}

function seoIssue(snapshot, issue) {
  const normalized = {
    code: cleanText(issue.code),
    field: cleanText(issue.field),
    level: ["P0", "P1", "P2"].includes(issue.level) ? issue.level : "P2",
    title: cleanText(issue.title),
    message: cleanText(issue.message),
    detail: cleanText(issue.detail),
    expected: cleanText(issue.expected)
  };
  return {
    id: hashJson({
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      url: snapshot.finalUrl || snapshot.url,
      code: normalized.code,
      field: normalized.field,
      detail: normalized.detail
    }),
    ...normalized
  };
}

function seoFieldValue(snapshot, key) {
  if (key === "openGraphTitle") {
    return snapshot.openGraph.title;
  }
  if (key === "openGraphDescription") {
    return snapshot.openGraph.description;
  }
  if (key === "canonicalStatus") {
    return displayUrlStatus(snapshot.canonicalStatus);
  }
  if (key === "hreflangs") {
    return snapshot.hreflangs.map((item) => `${item.hreflang}:${item.href}`);
  }
  if (key === "imageAltMissingCount") {
    return snapshot.imageAlt.missing;
  }
  if (key === "linkCounts") {
    return `${snapshot.linkCounts.internal}/${snapshot.linkCounts.external}/${snapshot.linkCounts.total}`;
  }
  if (key === "headings") {
    return snapshot.headings.map((heading) => `${heading.level}:${heading.text}`);
  }
  return snapshot[key];
}

function seoFieldLevel(field, beforeValue, afterValue) {
  if (field.key === "robots" && !containsNoindex(beforeValue) && containsNoindex(afterValue)) {
    return "P0";
  }
  if (field.key === "canonicalStatus" && /\b[45]\d\d\b/.test(displaySeoValue(afterValue))) {
    return "P0";
  }
  if (field.required && hasComparableValue(beforeValue) && !hasComparableValue(afterValue)) {
    return "P0";
  }
  return field.level || "P2";
}

function highestSeoLevel(fields) {
  if (fields.some((field) => field.level === "P0")) {
    return "P0";
  }
  if (fields.some((field) => field.level === "P1")) {
    return "P1";
  }
  return "P2";
}

function seoChangeLevelReason(level, fields) {
  const labels = fields.filter((field) => field.level === level).map((field) => field.label);
  if (level === "P0") {
    return `Critical SEO field became risky or empty: ${labels.join(", ")}`;
  }
  if (level === "P1") {
    return `Search-facing SEO content changed: ${labels.join(", ")}`;
  }
  return `Supporting SEO metadata changed: ${labels.join(", ")}`;
}

function seoChangeSummary(fields) {
  return fields.slice(0, 4)
    .map((field) => `${field.label}: ${field.before || "(empty)"} -> ${field.after || "(empty)"}`)
    .join("; ");
}

function seoSnapshotReference(snapshot) {
  return {
    seoSnapshotId: snapshot.id,
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    url: snapshot.url,
    finalUrl: snapshot.finalUrl,
    displayUrl: snapshot.displayUrl,
    targetId: snapshot.targetId,
    targetLabel: snapshot.targetLabel,
    platform: snapshot.platform,
    devicePresetId: snapshot.devicePresetId,
    capturePlanId: snapshot.capturePlanId,
    title: snapshot.title,
    metaDescription: snapshot.metaDescription,
    h1: snapshot.h1,
    canonical: snapshot.canonical,
    canonicalStatus: snapshot.canonicalStatus,
    hreflangs: snapshot.hreflangs,
    issueCount: snapshot.issueCount,
    highestIssueLevel: snapshot.highestIssueLevel
  };
}

function seoLocation(snapshot) {
  return {
    url: snapshot.url,
    finalUrl: snapshot.finalUrl,
    displayUrl: snapshot.displayUrl || snapshot.targetLabel || snapshot.finalUrl || snapshot.url,
    targetId: snapshot.targetId,
    targetLabel: snapshot.targetLabel,
    platform: snapshot.platform,
    devicePresetId: snapshot.devicePresetId,
    deviceProfileId: snapshot.deviceProfileId,
    capturePlanId: snapshot.capturePlanId
  };
}

function seoComparisonKey(snapshot) {
  return [
    snapshot.platform || "unknown",
    snapshot.targetId || "",
    normalizeUrlKey(snapshot.finalUrl || snapshot.url || snapshot.displayUrl)
  ].join("::");
}

function sameComparableValue(left, right) {
  return comparableValue(left) === comparableValue(right);
}

function comparableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(typeof item === "object" ? JSON.stringify(item) : item)).join("\n");
  }
  return cleanText(value);
}

function displaySeoValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(typeof item === "object" ? JSON.stringify(item) : item)).filter(Boolean).join(" | ");
  }
  return cleanText(value);
}

function hasComparableValue(value) {
  return Boolean(displaySeoValue(value));
}

function containsNoindex(value) {
  return /\bnoindex\b/i.test(displaySeoValue(value));
}

function normalizeHeadings(headings) {
  return (Array.isArray(headings) ? headings : [])
    .map((heading) => {
      if (typeof heading === "string") {
        return { level: "h2", text: cleanText(heading) };
      }
      const level = /^h[1-6]$/i.test(heading?.level || "") ? String(heading.level).toLowerCase() : "h2";
      return {
        level,
        text: cleanText(heading?.text)
      };
    })
    .filter((heading) => heading.text)
    .slice(0, 80);
}

function normalizeTextList(values) {
  const seen = new Set();
  const list = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (text && !seen.has(key)) {
      seen.add(key);
      list.push(text);
    }
  }
  return list.slice(0, 120);
}

function splitKeywords(value) {
  return cleanText(value)
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeIso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : cleanText(value);
}

function normalizedPlatform(value) {
  const platform = cleanText(value).toLowerCase();
  return platform === "pc" || platform === "mobile" ? platform : "";
}

function normalizeUrlKey(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return cleanText(value).replace(/\/$/, "");
  }
}

function normalizeUrlStatus(input) {
  if (!input || typeof input !== "object") {
    return {
      ok: false,
      status: 0,
      finalUrl: "",
      checkedAt: "",
      error: ""
    };
  }
  const status = Number(input.status || 0);
  return {
    ok: Boolean(input.ok),
    status: Number.isFinite(status) && status >= 0 ? Math.round(status) : 0,
    finalUrl: cleanText(input.finalUrl || input.url),
    checkedAt: normalizeIso(input.checkedAt),
    error: cleanText(input.error)
  };
}

function normalizeHreflangs(values) {
  const seen = new Set();
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    const hreflang = cleanText(value?.hreflang || value?.lang);
    const href = cleanText(value?.href || value?.url);
    if (!hreflang || !href) {
      continue;
    }
    const key = `${hreflang.toLowerCase()}::${normalizeUrlKey(href).toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    list.push({ hreflang, href });
    if (list.length >= 80) {
      break;
    }
  }
  return list;
}

function displayUrlStatus(status) {
  const normalized = normalizeUrlStatus(status);
  if (!normalized.status && !normalized.error && !normalized.finalUrl) {
    return "";
  }
  return [
    normalized.status ? `HTTP ${normalized.status}` : normalized.error ? "check failed" : "",
    normalized.finalUrl,
    normalized.error
  ].filter(Boolean).join(" ");
}

function missingExpectedHreflangs(snapshot = {}) {
  const expected = expectedRegionalHreflangs(snapshot);
  if (!expected.length) {
    return [];
  }
  const present = new Set(normalizeHreflangs(snapshot.hreflangs).map((item) => item.hreflang.toLowerCase()));
  return expected.filter((item) => !present.has(item.toLowerCase()));
}

function expectedRegionalHreflangs(snapshot = {}) {
  const url = parseHttpUrl(snapshot.finalUrl || snapshot.url || snapshot.canonical || snapshot.displayUrl);
  if (!url || !["shokz.com", "ca.shokz.com"].includes(url.hostname.toLowerCase())) {
    return [];
  }
  if (!/^\/(?:pages|products)\//i.test(url.pathname)) {
    return [];
  }
  return ["en-US", "en-CA"];
}

function hreflangSummary(values) {
  const normalized = normalizeHreflangs(values);
  return normalized.length
    ? normalized.map((item) => `${item.hreflang}: ${item.href}`).join(" | ")
    : "(none)";
}

function repeatedLeadingTitlePhrase(title) {
  const text = cleanText(title)
    .replace(/&amp;/gi, "&")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-");
  const compact = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const maxLength = Math.min(48, Math.floor(compact.length / 2));
  for (let length = 6; length <= maxLength; length += 1) {
    const phrase = compact.slice(0, length);
    if (phrase === compact.slice(length, length * 2)) {
      return phrase;
    }
  }
  return "";
}

function parseHttpUrl(value) {
  try {
    const url = new URL(cleanText(value));
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function compareSeoRecordsNewestFirst(a, b) {
  return String(b?.capturedAt || b?.createdAt || "").localeCompare(String(a?.capturedAt || a?.createdAt || ""));
}

function timestamp(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function hashJson(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
