import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { checkText, getDefaultBundledSettingsAsync, suggestionsForWord } from "cspell-lib";
import { parse } from "parse5";
import { textQualityPath } from "./paths.js";
import { loadConfig, loadSnapshots, resolveConfiguredCapturePlans } from "./store.js";

const maxIssuesPerRecord = 120;
const maxSuggestions = 3;
const maxHtmlAttributeBlocks = 180;
const maxHtmlTextBlocks = 240;
const htmlFetchTimeoutMs = 12000;
const customDictionaryWords = [
  "Aeropex",
  "AfterShokz",
  "Bassphere",
  "Bluetooth",
  "beamforming",
  "Deutsch",
  "DingTalk",
  "Dakotah",
  "digitaltrends",
  "Dryland",
  "Eliud",
  "Ironman",
  "italiana",
  "Kelaigh",
  "Kipchoge",
  "Mantz",
  "multipoint",
  "Nederland",
  "Nederlands",
  "Obiri",
  "OpenComm",
  "OpenDots",
  "OpenFit",
  "OpenMeet",
  "OpenMove",
  "OpenRun",
  "OpenSwim",
  "pearlescent",
  "Philipp",
  "Pianokeys",
  "Polska",
  "Popehn",
  "polski",
  "Rossany",
  "Shokz",
  "Shopify",
  "Sweatproof",
  "Swimproof",
  "Tawnya",
  "Topbar",
  "USB",
  "wearability",
  "WebPage",
  "Welman"
];
const knownCorrections = new Map([
  ["chicaliforniago", "Chicago"],
  ["californiago", "Chicago"],
  ["condcution", "conduction"],
  ["regiter", "register"],
  ["sentense", "sentence"]
]);
const textLikeHtmlAttributes = new Set([
  "aria-description",
  "aria-label",
  "content",
  "placeholder",
  "title"
]);
const technicalHtmlAttributes = new Set(["class", "id", "name"]);
const ignoredHtmlTags = new Set([
  "script",
  "style",
  "svg",
  "path",
  "use",
  "defs",
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "source",
  "template",
  "noscript"
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
  const configuredSnapshots = (!Array.isArray(options.snapshots) || options.includeConfiguredTargets === true)
    ? await configuredTargetSnapshotsWithoutRecords(targetSnapshots, options)
    : [];
  const checkedAt = new Date().toISOString();
  const settings = await textQualitySettings();
  const suggestionCache = new Map();
  const htmlFetchCache = options.htmlFetchCache || new Map();
  const htmlAttributeOwnerIds = htmlAttributeOwnerSnapshotIds([
    ...targetSnapshots,
    ...configuredSnapshots
  ]);
  const sharedOptions = {
    ...options,
    checkedAt,
    settings,
    suggestionCache,
    htmlFetchCache,
    fetchHtmlAttributes: options.fetchHtmlAttributes !== false
  };
  const records = [];

  for (const snapshot of [...targetSnapshots, ...configuredSnapshots]) {
    const htmlUrl = snapshotHtmlUrl(snapshot);
    const htmlUrlKey = htmlUrl ? `${normalizedPlatform(snapshot.platform)}::${htmlUrl}` : "";
    const shouldFetchHtmlAttributes = Boolean(sharedOptions.fetchHtmlAttributes && htmlUrlKey && htmlAttributeOwnerIds.has(snapshot.id));
    const record = await createTextQualityRecord(snapshot, {
      ...sharedOptions,
      fetchHtmlAttributes: shouldFetchHtmlAttributes
    });
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
  const blocks = [
    ...collectTextBlocks(snapshot),
    ...await collectHtmlAttributeBlocks(snapshot, options)
  ];
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
    if (!shouldReportWord(wrong, block) || isProbablyTruncatedIssue(block.text, expanded)) {
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
      imageUrl: block.imageUrl,
      attributeName: block.attributeName,
      element: block.element
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
      imageUrl: block.imageUrl,
      attributeName: block.attributeName,
      element: block.element
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
      imageUrl: block.imageUrl,
      attributeName: block.attributeName,
      element: block.element
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
      imageUrl: cleanText(meta.imageUrl),
      attributeName: cleanText(meta.attributeName),
      element: cleanText(meta.element),
      checkMode: cleanText(meta.checkMode)
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

async function configuredTargetSnapshotsWithoutRecords(existingSnapshots, options = {}) {
  if (options.includeConfiguredTargets === false) {
    return [];
  }
  const config = options.config || await loadConfig().catch(() => null);
  if (!config) {
    return [];
  }
  const existingKeys = new Set((Array.isArray(existingSnapshots) ? existingSnapshots : [])
    .map((snapshot) => textQualityPageKey(snapshot)));
  return resolveConfiguredCapturePlans(config)
    .filter((plan) => plan?.target?.url)
    .filter((plan) => !existingKeys.has(textQualityPageKey({
      platform: plan.platform,
      targetId: plan.target.id,
      displayUrl: plan.target.label || plan.target.url
    })))
    .map((plan) => ({
      id: `configured-${plan.platform}-${plan.target.id}-${plan.deviceProfile.id}`,
      url: plan.target.url,
      requestedUrl: plan.target.url,
      finalUrl: plan.target.url,
      targetId: plan.target.id,
      targetLabel: plan.target.label || plan.target.url,
      displayUrl: plan.target.label || plan.target.url,
      platform: plan.platform,
      devicePresetId: plan.devicePreset?.id || plan.deviceProfile.devicePresetId,
      deviceProfileId: plan.deviceProfile.id,
      capturePlanId: plan.id,
      title: plan.target.label || plan.target.url,
      capturedAt: ""
    }));
}

function textQualityPageKey(snapshot = {}) {
  return [
    normalizedPlatform(snapshot.platform),
    cleanText(snapshot.targetId),
    cleanText(snapshot.displayUrl || snapshot.finalUrl || snapshot.url)
  ].join("::");
}

function htmlAttributeOwnerSnapshotIds(snapshots) {
  const owners = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const htmlUrl = snapshotHtmlUrl(snapshot);
    if (!snapshot?.id || !htmlUrl) {
      continue;
    }
    const key = `${normalizedPlatform(snapshot.platform)}::${htmlUrl}`;
    const current = owners.get(key);
    if (!current || compareHtmlAttributeOwner(snapshot, current) > 0) {
      owners.set(key, snapshot);
    }
  }
  return new Set([...owners.values()].map((snapshot) => snapshot.id));
}

function compareHtmlAttributeOwner(left, right) {
  const scoreDiff = htmlAttributeOwnerScore(left) - htmlAttributeOwnerScore(right);
  if (scoreDiff) {
    return scoreDiff;
  }
  return String(left?.capturedAt || "").localeCompare(String(right?.capturedAt || ""));
}

function htmlAttributeOwnerScore(snapshot = {}) {
  const haystack = [
    snapshot.targetId,
    snapshot.targetLabel,
    snapshot.displayUrl,
    snapshot.captureMode
  ].map(cleanText).join(" ").toLowerCase();
  let score = 0;
  if (/home|首页|shokz-home/.test(haystack)) {
    score += 100;
  }
  if (/nav|navigation|导航/.test(haystack)) {
    score -= 80;
  }
  if (/comparison|对比/.test(haystack)) {
    score += 20;
  }
  if (/collection|集合/.test(haystack)) {
    score += 20;
  }
  return score;
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

async function collectHtmlAttributeBlocks(snapshot, options = {}) {
  const directHtml = cleanHtmlSource(options.htmlSource || snapshot.htmlSource || snapshot.html);
  if (directHtml) {
    return htmlAttributeBlocksFromHtml(directHtml, snapshot);
  }
  if (options.fetchHtmlAttributes !== true) {
    return [];
  }
  const url = snapshotHtmlUrl(snapshot);
  if (!url) {
    return [];
  }
  const html = await htmlSourceForUrl(url, options).catch(() => "");
  return html ? htmlAttributeBlocksFromHtml(html, snapshot) : [];
}

async function htmlSourceForUrl(url, options = {}) {
  const cache = options.htmlFetchCache;
  if (cache?.has(url)) {
    return cache.get(url);
  }
  const promise = fetchHtmlSource(url, options);
  if (cache) {
    cache.set(url, promise);
  }
  const html = await promise.catch(() => "");
  if (cache) {
    cache.set(url, html);
  }
  return html;
}

async function fetchHtmlSource(url, options = {}) {
  const fetcher = options.htmlFetcher || globalThis.fetch;
  if (typeof fetcher !== "function") {
    return "";
  }
  const response = await fetcher(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "user-agent": "jietu-woodpecker/1.0"
    },
    signal: AbortSignal.timeout(Number(options.htmlFetchTimeoutMs) || htmlFetchTimeoutMs)
  });
  if (typeof response === "string") {
    return cleanHtmlSource(response);
  }
  if (!response?.ok) {
    return "";
  }
  const contentType = cleanText(response.headers?.get?.("content-type")).toLowerCase();
  if (contentType && !/html|text/.test(contentType)) {
    return "";
  }
  return cleanHtmlSource(await response.text());
}

function htmlAttributeBlocksFromHtml(html, snapshot = {}) {
  const blocks = [];
  const seen = new Set();
  const document = parse(html);

  const addAttributeBlock = (node, attr, checkMode) => {
    const name = cleanText(attr?.name).toLowerCase();
    const value = cleanAttributeValue(attr?.value);
    if (!name || !value || !shouldCheckHtmlAttributeValue(value, name)) {
      return;
    }
    const tagName = cleanText(node?.tagName || node?.nodeName).toLowerCase();
    const text = `${name}="${value}"`;
    const key = [tagName, name, value.toLowerCase()].join("::");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    blocks.push({
      text,
      source: checkMode === "technical-attribute" ? "html-attribute-technical" : "html-attribute",
      sourceLabel: checkMode === "technical-attribute" ? "HTML 属性（源码命名）" : "HTML 属性",
      location: htmlAttributeLocation(node, name),
      sectionKey: "html-source",
      sectionLabel: "HTML 源码",
      imageUrl: snapshot.imageUrl,
      attributeName: name,
      element: tagName,
      checkMode
    });
  };

  const visit = (node) => {
    const tagName = cleanText(node?.tagName || node?.nodeName).toLowerCase();
    if (ignoredHtmlTags.has(tagName)) {
      return;
    }
    for (const attr of Array.isArray(node?.attrs) ? node.attrs : []) {
      const name = cleanText(attr?.name).toLowerCase();
      if (isTextLikeHtmlAttribute(node, name)) {
        addAttributeBlock(node, attr, "text-attribute");
      } else if (isTechnicalHtmlAttribute(name) && hasKnownCorrectionToken(attr?.value)) {
        addAttributeBlock(node, attr, "technical-attribute");
      }
      if (blocks.length >= maxHtmlAttributeBlocks) {
        return;
      }
    }
    for (const child of Array.isArray(node?.childNodes) ? node.childNodes : []) {
      if (blocks.length >= maxHtmlAttributeBlocks) {
        return;
      }
      visit(child);
    }
  };

  visit(document);
  return [
    ...htmlTextBlocksFromDocument(document, snapshot),
    ...blocks
  ];
}

function htmlTextBlocksFromDocument(document, snapshot = {}) {
  const blocks = [];
  const seen = new Set();

  const addTextBlock = (text, nodeStack) => {
    const cleaned = cleanHtmlTextValue(text);
    if (!shouldCheckHtmlTextValue(cleaned)) {
      return;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    blocks.push({
      text: cleaned,
      source: "html-text",
      sourceLabel: "HTML text",
      location: htmlTextLocation(nodeStack),
      sectionKey: "html-source",
      sectionLabel: "HTML source",
      imageUrl: snapshot.imageUrl
    });
  };

  const visit = (node, stack = []) => {
    const tagName = cleanText(node?.tagName || node?.nodeName).toLowerCase();
    if (ignoredHtmlTags.has(tagName)) {
      return;
    }
    if (node?.nodeName === "#text") {
      addTextBlock(node.value, stack);
      return;
    }
    const nextStack = tagName && tagName !== "#document"
      ? [...stack, node]
      : stack;
    for (const child of Array.isArray(node?.childNodes) ? node.childNodes : []) {
      if (blocks.length >= maxHtmlTextBlocks) {
        return;
      }
      visit(child, nextStack);
    }
  };

  visit(document);
  return blocks;
}

function isTextLikeHtmlAttribute(node, name) {
  if (!name) {
    return false;
  }
  if (textLikeHtmlAttributes.has(name)) {
    if (name !== "content") {
      return true;
    }
    return isTextLikeMetaContent(node);
  }
  return name.startsWith("data-") &&
    /(?:alt|caption|description|heading|label|text|title)$/i.test(name);
}

function isTextLikeMetaContent(node) {
  const tagName = cleanText(node?.tagName || node?.nodeName).toLowerCase();
  if (tagName !== "meta") {
    return false;
  }
  const attrs = new Map((Array.isArray(node?.attrs) ? node.attrs : [])
    .map((attr) => [cleanText(attr?.name).toLowerCase(), cleanText(attr?.value).toLowerCase()]));
  const metaName = attrs.get("name") || attrs.get("property") || "";
  return /(?:description|keywords|title|og:title|og:description|twitter:title|twitter:description)/i.test(metaName);
}

function isTechnicalHtmlAttribute(name) {
  return technicalHtmlAttributes.has(name) || name.startsWith("data-");
}

function hasKnownCorrectionToken(value) {
  return splitAttributeWords(value)
    .some((word) => knownCorrections.has(word.toLowerCase()));
}

function splitAttributeWords(value) {
  return cleanText(value)
    .split(/[^A-Za-z]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function shouldCheckHtmlAttributeValue(value, name = "") {
  const cleaned = cleanText(value);
  return cleaned.length >= 3 &&
    cleaned.length <= 500 &&
    /[A-Za-z]{3,}/.test(cleaned) &&
    !/^(?:https?:|data:|mailto:|tel:)/i.test(cleaned) &&
    !/\bgid:\/\/|:\/\/|shopify\/|^[A-Za-z0-9_-]+\/[A-Za-z0-9/_-]+$/i.test(cleaned) &&
    !isLikelyMachineAttributeValue(cleaned, name);
}

function isLikelyMachineAttributeValue(value, name = "") {
  if (hasKnownCorrectionToken(value)) {
    return false;
  }
  const cleaned = cleanText(value);
  if (!cleaned) {
    return true;
  }
  if (!/\s/.test(cleaned) && /[-_:]/.test(cleaned)) {
    return true;
  }
  if (/^(?:slide|swiper|variant|product|filter)[-_:\w]+$/i.test(cleaned)) {
    return true;
  }
  return cleanText(name).toLowerCase() === "title" && /^gid:\/\//i.test(cleaned);
}

function cleanHtmlSource(value) {
  return String(value || "").slice(0, 2_000_000);
}

function cleanAttributeValue(value) {
  return String(value || "")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function cleanHtmlTextValue(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function shouldCheckHtmlTextValue(value) {
  const cleaned = cleanText(value);
  return cleaned.length >= 3 &&
    cleaned.length <= 360 &&
    /[A-Za-z]{3,}/.test(cleaned) &&
    !/^[{}[\]():,.;\d\s$€£¥+-]+$/.test(cleaned) &&
    !/^https?:\/\//i.test(cleaned);
}

function htmlAttributeLocation(node, name) {
  const tagName = cleanText(node?.tagName || node?.nodeName).toLowerCase() || "element";
  const attrs = new Map((Array.isArray(node?.attrs) ? node.attrs : [])
    .map((attr) => [cleanText(attr?.name).toLowerCase(), cleanText(attr?.value)]));
  const id = attrs.get("id");
  const className = attrs.get("class");
  const elementHint = id
    ? `<${tagName}#${id}>`
    : className
      ? `<${tagName}.${className.split(/\s+/)[0]}>`
      : `<${tagName}>`;
  return `${elementHint} @${name}`;
}

function htmlTextLocation(nodeStack = []) {
  const node = [...nodeStack].reverse()
    .find((candidate) => {
      const tagName = cleanText(candidate?.tagName || candidate?.nodeName).toLowerCase();
      return tagName && tagName !== "#document" && !ignoredHtmlTags.has(tagName);
    });
  const tagName = cleanText(node?.tagName || node?.nodeName).toLowerCase() || "text";
  const attrs = new Map((Array.isArray(node?.attrs) ? node.attrs : [])
    .map((attr) => [cleanText(attr?.name).toLowerCase(), cleanText(attr?.value)]));
  const id = attrs.get("id");
  const className = attrs.get("class");
  if (id) {
    return `<${tagName}#${id}> text`;
  }
  if (className) {
    return `<${tagName}.${className.split(/\s+/)[0]}> text`;
  }
  return `<${tagName}> text`;
}

function snapshotHtmlUrl(snapshot = {}) {
  const url = cleanText(snapshot.finalUrl || snapshot.requestedUrl || snapshot.url);
  if (!/^https?:\/\//i.test(url)) {
    return "";
  }
  return url;
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
    imageUrl: cleanText(input.imageUrl),
    attributeName: cleanText(input.attributeName),
    element: cleanText(input.element)
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

function shouldReportWord(word, block = {}) {
  const cleaned = cleanText(word);
  const lower = cleaned.toLowerCase();
  if (cleanText(block.checkMode) === "technical-attribute" && !knownCorrections.has(lower)) {
    return false;
  }
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
