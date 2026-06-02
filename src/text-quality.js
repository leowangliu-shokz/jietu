import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { checkText, getDefaultBundledSettingsAsync, suggestionsForWord } from "cspell-lib";
import { textQualityPath } from "./paths.js";
import { loadSnapshots } from "./store.js";

const maxIssuesPerRecord = 120;
const maxSuggestions = 3;
const customDictionaryWords = [
  "Aeropex",
  "AfterShokz",
  "Bluetooth",
  "DingTalk",
  "Dakotah",
  "Dryland",
  "Eliud",
  "Ironman",
  "Kipchoge",
  "Mantz",
  "Obiri",
  "OpenComm",
  "OpenDots",
  "OpenFit",
  "OpenMeet",
  "OpenMove",
  "OpenRun",
  "OpenSwim",
  "Philipp",
  "Popehn",
  "Shokz",
  "Shopify",
  "Sweatproof",
  "Swimproof",
  "Topbar",
  "USB",
  "WebPage",
  "Welman"
];
const knownCorrections = new Map([
  ["chicaliforniago", "Chicago"],
  ["californiago", "Chicago"],
  ["regiter", "register"],
  ["sentense", "sentence"]
]);

let settingsPromise = null;

export async function loadTextQualityRecords(filePath = textQualityPath) {
  const parsed = await readJson(filePath, []);
  return Array.isArray(parsed)
    ? parsed.map(normalizeTextQualityRecord).filter(Boolean).sort(compareTextQualityNewestFirst)
    : [];
}

export async function saveTextQualityRecords(records, filePath = textQualityPath) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeTextQualityRecord)
    .filter(Boolean)
    .sort(compareTextQualityNewestFirst);
  await writeJson(filePath, normalized);
  return normalized;
}

export async function rebuildTextQuality(options = {}) {
  const snapshots = Array.isArray(options.snapshots)
    ? options.snapshots
    : await loadSnapshots();
  const targetSnapshots = options.latestOnly === false
    ? snapshots
    : latestSnapshotsByPage(snapshots);
  const checkedAt = new Date().toISOString();
  const settings = await textQualitySettings();
  const suggestionCache = new Map();
  const records = [];

  for (const snapshot of targetSnapshots) {
    const record = await createTextQualityRecord(snapshot, { checkedAt, settings, suggestionCache });
    if (record) {
      records.push(record);
    }
  }

  return saveTextQualityRecords(records, options.textQualityFilePath || textQualityPath);
}

export async function deleteTextQualityRecordsForSnapshotIds(snapshotIds, options = {}) {
  const deleteSet = new Set(
    (Array.isArray(snapshotIds) ? snapshotIds : [snapshotIds])
      .map((snapshotId) => cleanText(snapshotId))
      .filter(Boolean)
  );
  if (!deleteSet.size) {
    return { ok: true, deletedCount: 0 };
  }

  const filePath = options.textQualityFilePath || textQualityPath;
  const records = await loadTextQualityRecords(filePath);
  const remaining = records.filter((record) => !deleteSet.has(record.snapshotId));
  const deletedCount = records.length - remaining.length;
  if (deletedCount > 0) {
    await saveTextQualityRecords(remaining, filePath);
  }
  return { ok: true, deletedCount };
}

export function buildTextQualitySummary(records = []) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeTextQualityRecord)
    .filter(Boolean)
    .sort(compareTextQualityNewestFirst);
  const issueCount = normalized.reduce((sum, record) => sum + record.issueCount, 0);
  return {
    recordCount: normalized.length,
    issueCount,
    okCount: normalized.filter((record) => record.issueCount === 0).length,
    warningCount: normalized.filter((record) => record.issueCount > 0).length,
    latestRecord: normalized[0] || null,
    recentIssues: normalized.flatMap((record) =>
      record.issues.slice(0, 3).map((issue) => ({
        ...issue,
        snapshotId: record.snapshotId,
        url: record.finalUrl || record.url,
        displayUrl: record.displayUrl,
        platform: record.platform,
        capturedAt: record.capturedAt
      }))
    ).slice(0, 12)
  };
}

export async function createTextQualityRecord(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || !cleanText(snapshot.id)) {
    return null;
  }

  const settings = options.settings || await textQualitySettings();
  const blocks = collectTextBlocks(snapshot);
  const issues = [];
  const seenIssueKeys = new Set();

  for (const block of blocks) {
    if (!shouldCheckBlock(block.text)) {
      continue;
    }
    for (const issue of await spellingIssuesForBlock(block, settings, options)) {
      addIssue(issues, seenIssueKeys, issue);
      if (issues.length >= maxIssuesPerRecord) break;
    }
    if (issues.length >= maxIssuesPerRecord) break;

    for (const issue of grammarIssuesForBlock(block)) {
      addIssue(issues, seenIssueKeys, issue);
      if (issues.length >= maxIssuesPerRecord) break;
    }
    if (issues.length >= maxIssuesPerRecord) break;
  }

  return normalizeTextQualityRecord({
    id: `${snapshot.id}-text-quality`,
    snapshotId: snapshot.id,
    capturedAt: snapshot.capturedAt,
    checkedAt: options.checkedAt || new Date().toISOString(),
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
    issueCount: issues.length,
    status: issues.length ? "warning" : "ok",
    issues
  });
}

async function spellingIssuesForBlock(block, settings, options = {}) {
  const result = await checkText(block.text, settings);
  const issues = [];

  for (const item of result.items || []) {
    if (!item?.isError) {
      continue;
    }
    const expanded = expandKnownWrongWord(block.text, item.startPos, item.endPos, item.text);
    const wrong = expanded.word;
    if (!shouldReportWord(wrong) || isProbablyTruncatedIssue(block.text, expanded)) {
      continue;
    }
    const suggestedWords = await spellingSuggestions(wrong, settings, options.suggestionCache);
    const correction = knownCorrections.get(wrong.toLowerCase()) || suggestedWords[0] || "";
    const expected = correction
      ? replaceRange(block.text, expanded.start, expanded.end, correction)
      : `请人工确认 "${wrong}" 的正确写法`;
    issues.push({
      id: issueId("spelling", block, wrong, expanded.start),
      type: "spelling",
      level: "P1",
      message: `疑似拼写错误：${wrong}`,
      wrong,
      suggestions: correction
        ? [correction, ...suggestedWords.filter((word) => word !== correction)].slice(0, maxSuggestions)
        : suggestedWords,
      expected,
      context: block.text,
      source: block.source,
      sourceLabel: block.sourceLabel,
      location: block.location,
      sectionKey: block.sectionKey,
      sectionLabel: block.sectionLabel,
      imageUrl: block.imageUrl
    });
  }

  return issues;
}

async function spellingSuggestions(word, settings, suggestionCache = null) {
  const known = knownCorrections.get(String(word || "").toLowerCase());
  if (known) {
    return [known];
  }

  const cacheKey = String(word || "").toLowerCase();
  if (suggestionCache?.has(cacheKey)) {
    return suggestionCache.get(cacheKey);
  }
  const result = await suggestionsForWord(word, { numSuggestions: maxSuggestions }, settings).catch(() => null);
  const suggestions = (result?.suggestions || [])
    .map((suggestion) => cleanText(suggestion?.word || suggestion))
    .filter(Boolean)
    .slice(0, maxSuggestions);
  if (suggestionCache) {
    suggestionCache.set(cacheKey, suggestions);
  }
  return suggestions;
}

function grammarIssuesForBlock(block) {
  if (!shouldCheckGrammarBlock(block)) {
    return [];
  }

  const issues = [];
  const repeatedWord = /\b([A-Za-z][A-Za-z'-]{2,})\s+\1\b/gi;
  for (const match of block.text.matchAll(repeatedWord)) {
    if (isLikelyRepeatedTitleLabel(match[0])) {
      continue;
    }
    const expected = replaceRange(block.text, match.index, match.index + match[0].length, match[1]);
    issues.push({
      id: issueId("grammar", block, match[0], match.index),
      type: "grammar",
      level: "P2",
      message: `重复单词：${match[0]}`,
      wrong: match[0],
      suggestions: [match[1]],
      expected,
      context: block.text,
      source: block.source,
      sourceLabel: block.sourceLabel,
      location: block.location,
      sectionKey: block.sectionKey,
      sectionLabel: block.sectionLabel,
      imageUrl: block.imageUrl
    });
  }

  const spaceBeforePunctuation = /\s+([,.;:!?])/g;
  for (const match of block.text.matchAll(spaceBeforePunctuation)) {
    const expected = replaceRange(block.text, match.index, match.index + match[0].length, match[1]);
    issues.push({
      id: issueId("grammar", block, match[0], match.index),
      type: "grammar",
      level: "P2",
      message: "标点前存在多余空格",
      wrong: match[0],
      suggestions: [match[1]],
      expected,
      context: block.text,
      source: block.source,
      sourceLabel: block.sourceLabel,
      location: block.location,
      sectionKey: block.sectionKey,
      sectionLabel: block.sectionLabel,
      imageUrl: block.imageUrl
    });
  }

  return issues;
}

function collectTextBlocks(snapshot) {
  const blocks = [];
  const seen = new Set();
  const addText = (text, meta = {}) => {
    const cleaned = cleanBlockText(text);
    if (!cleaned) {
      return;
    }
    const key = [
      meta.source || "",
      meta.sectionKey || "",
      meta.location || "",
      cleaned.toLowerCase()
    ].join("::");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    blocks.push({
      text: cleaned,
      source: meta.source || "text",
      sourceLabel: meta.sourceLabel || "页面文案",
      location: meta.location || meta.sectionLabel || "页面",
      sectionKey: cleanText(meta.sectionKey),
      sectionLabel: cleanText(meta.sectionLabel),
      imageUrl: cleanText(meta.imageUrl)
    });
  };

  addText(snapshot.title, {
    source: "document-title",
    sourceLabel: "页面标题",
    location: "页面标题",
    imageUrl: snapshot.imageUrl
  });
  collectStateText(snapshot.bannerState, addText, {
    source: "banner",
    sourceLabel: "Banner 文案",
    sectionKey: "banner",
    sectionLabel: "Banner",
    location: "Banner",
    imageUrl: snapshot.imageUrl
  });

  for (const shot of Array.isArray(snapshot.relatedShots) ? snapshot.relatedShots : []) {
    const location = [
      shot.sectionLabel || shot.sectionKey,
      shot.stateLabel,
      shot.tabLabel,
      shot.productLabel,
      shot.variantLabel
    ].map(cleanText).filter(Boolean).join(" / ") || "更多截图";
    const meta = {
      source: "related-shot",
      sourceLabel: "更多截图文案",
      sectionKey: shot.sectionKey,
      sectionLabel: shot.sectionLabel,
      location,
      imageUrl: shot.imageUrl
    };
    collectStateText(shot.sectionState || shot.bannerState, addText, meta);
    collectVisibleItems(shot.visibleItems, addText, meta);
  }

  collectVisibleItems(snapshot.homeOverview?.visibleItems, addText, {
    source: "home-overview",
    sourceLabel: "首页总览文案",
    sectionKey: snapshot.homeOverview?.sectionKey,
    sectionLabel: snapshot.homeOverview?.sectionLabel,
    location: snapshot.homeOverview?.sectionLabel || "首页总览",
    imageUrl: snapshot.homeOverview?.imageUrl
  });

  return blocks.slice(0, 220);
}

function latestSnapshotsByPage(snapshots) {
  const seen = new Set();
  return [...(Array.isArray(snapshots) ? snapshots : [])]
    .filter((snapshot) => snapshot && typeof snapshot === "object")
    .sort((a, b) =>
      String(b.capturedAt || "").localeCompare(String(a.capturedAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
    )
    .filter((snapshot) => {
      const key = [
        normalizedPlatform(snapshot.platform),
        cleanText(snapshot.targetId),
        cleanText(snapshot.displayUrl || snapshot.finalUrl || snapshot.url)
      ].join("::");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function collectStateText(state, addText, meta) {
  if (!state || typeof state !== "object") {
    return;
  }

  for (const block of Array.isArray(state.textBlocks) ? state.textBlocks : []) {
    addText(block?.text, { ...meta, source: "text-block" });
  }
  for (const image of Array.isArray(state.images) ? state.images : []) {
    addText(image?.alt, { ...meta, source: "image-alt", sourceLabel: "图片 Alt" });
  }
  collectVisibleItems(state.visibleItems, addText, meta);
}

function collectVisibleItems(items, addText, meta) {
  for (const item of Array.isArray(items) ? items : []) {
    addText(item?.label, { ...meta, source: "visible-item", sourceLabel: "可见元素文案" });
    if (!cleanText(item?.label) && cleanText(item?.text).length <= 180) {
      addText(item?.text, { ...meta, source: "visible-item", sourceLabel: "可见元素文案" });
    }
  }
}

function normalizeTextQualityRecord(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const id = cleanText(input.id) || hashJson({
    snapshotId: input.snapshotId,
    capturedAt: input.capturedAt,
    url: input.finalUrl || input.url
  });
  const issues = (Array.isArray(input.issues) ? input.issues : [])
    .map(normalizeIssue)
    .filter(Boolean);
  return {
    id,
    snapshotId: cleanText(input.snapshotId),
    capturedAt: normalizeIso(input.capturedAt),
    checkedAt: normalizeIso(input.checkedAt),
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
    title: cleanText(input.title),
    status: issues.length ? "warning" : "ok",
    issueCount: issues.length,
    issues
  };
}

function normalizeIssue(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const wrong = cleanText(input.wrong);
  const context = cleanText(input.context);
  if (!wrong && !context) {
    return null;
  }
  return {
    id: cleanText(input.id) || hashJson(input),
    type: cleanText(input.type) || "spelling",
    level: /^P[0-2]$/.test(input.level || "") ? input.level : "P2",
    message: cleanText(input.message),
    wrong,
    suggestions: normalizeTextList(input.suggestions).slice(0, maxSuggestions),
    expected: cleanText(input.expected),
    context,
    source: cleanText(input.source),
    sourceLabel: cleanText(input.sourceLabel),
    location: cleanText(input.location),
    sectionKey: cleanText(input.sectionKey),
    sectionLabel: cleanText(input.sectionLabel),
    imageUrl: cleanText(input.imageUrl)
  };
}

async function textQualitySettings() {
  if (!settingsPromise) {
    settingsPromise = getDefaultBundledSettingsAsync().then((settings) => ({
      ...settings,
      language: "en-US",
      allowCompoundWords: false,
      numSuggestions: maxSuggestions,
      maxNumberOfProblems: 1000,
      words: [
        ...(Array.isArray(settings.words) ? settings.words : []),
        ...customDictionaryWords
      ]
    }));
  }
  return settingsPromise;
}

function addIssue(issues, seenIssueKeys, issue) {
  const key = [
    issue.type,
    issue.wrong,
    issue.suggestions?.[0] || issue.expected || "",
    issue.location,
    issue.source
  ].join("::").toLowerCase();
  if (seenIssueKeys.has(key)) {
    return;
  }
  seenIssueKeys.add(key);
  issues.push(issue);
}

function expandKnownWrongWord(text, start, end, word) {
  const rawWord = cleanText(word);
  const safeStart = Math.max(0, Number(start || 0));
  const safeEnd = Math.max(safeStart, Number(end || safeStart + rawWord.length));
  const nearby = String(text || "").slice(Math.max(0, safeStart - 24), safeEnd);
  const fullWord = nearby.match(/[A-Za-z][A-Za-z'-]*$/)?.[0] || rawWord;
  if (knownCorrections.has(fullWord.toLowerCase())) {
    return {
      word: fullWord,
      start: safeEnd - fullWord.length,
      end: safeEnd
    };
  }
  return {
    word: rawWord,
    start: safeStart,
    end: safeEnd
  };
}

function replaceRange(text, start, end, replacement) {
  return [
    String(text || "").slice(0, start),
    replacement,
    String(text || "").slice(end)
  ].join("");
}

function issueId(type, block, wrong, offset) {
  return hashJson({
    type,
    wrong,
    offset,
    text: block.text,
    source: block.source,
    location: block.location
  });
}

function shouldCheckBlock(text) {
  return /[A-Za-z]{3,}/.test(text || "");
}

function shouldCheckGrammarBlock(block) {
  return ["document-title", "text-block", "image-alt"].includes(block.source) &&
    cleanText(block.text).length <= 220;
}

function shouldReportWord(word) {
  const cleaned = cleanText(word);
  return /^[A-Za-z][A-Za-z-]{2,}$/.test(cleaned) &&
    !/^[A-Z]{2,}$/.test(cleaned) &&
    !/\d/.test(cleaned);
}

function isProbablyTruncatedIssue(text, expanded) {
  const value = String(text || "");
  return expanded.end >= value.length &&
    value.length >= 80 &&
    /[a-z]$/.test(value) &&
    expanded.word.length <= 12;
}

function isLikelyRepeatedTitleLabel(value) {
  const parts = cleanText(value).split(/\s+/);
  if (parts.length !== 2 || parts[0] !== parts[1]) {
    return false;
  }
  return /^[A-Z][A-Za-z0-9+-]*$/.test(parts[0]);
}

function cleanBlockText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTextList(value) {
  return (Array.isArray(value) ? value : [value])
    .map(cleanText)
    .filter(Boolean);
}

function normalizedPlatform(value) {
  const platform = cleanText(value).toLowerCase();
  return platform === "mobile" ? "mobile" : "pc";
}

function normalizeIso(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function compareTextQualityNewestFirst(a, b) {
  return String(b?.capturedAt || "").localeCompare(String(a?.capturedAt || "")) ||
    String(b?.checkedAt || "").localeCompare(String(a?.checkedAt || "")) ||
    String(a?.id || "").localeCompare(String(b?.id || ""));
}

function hashJson(value) {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 24);
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
