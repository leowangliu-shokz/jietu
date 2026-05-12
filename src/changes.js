import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { archiveDir, changesPath } from "./paths.js";
import { normalizeCaptureConfidence } from "./capture-confidence.js";
import { decodePng, encodePng } from "./png.js";
import { loadSnapshots, publicSnapshotUrl } from "./store.js";

const defaultDiffOptions = {
  pixelDeltaThreshold: 48,
  minRegionPixels: 24,
  minRegionArea: 16,
  mergeGap: 8,
  maxRegions: 40,
  alignmentDriftMaxShift: 2,
  alignmentDriftSamplePixels: 20000,
  alignmentDriftImprovementRatio: 0.25,
  alignmentDriftMaxRatio: 0.12
};

const defaultVisualJudgmentOptions = {
  pageMinRatio: 0.02,
  sectionMinRatio: 0.04,
  bannerMinRatio: 0.12,
  layoutMoveMinPixels: 48,
  layoutMoveMinRatio: 0.08,
  layoutResizeRatio: 0.35,
  mediaRectMoveMinPixels: 8,
  mediaRectResizeRatio: 0.08
};

export async function loadChanges(filePath = changesPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(parsed)
      ? parsed.sort((a, b) => String(b.to?.capturedAt || "").localeCompare(String(a.to?.capturedAt || "")))
      : [];
  } catch {
    return [];
  }
}

export async function saveChanges(changes, filePath = changesPath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(changes, null, 2)}\n`, "utf8");
  return changes;
}

export async function rebuildChanges(options = {}) {
  const snapshots = options.snapshots || await loadSnapshots();
  const changes = await compareSnapshots(snapshots, options);
  await saveChanges(changes, options.changesFilePath || changesPath);
  return changes;
}

export async function compareSnapshots(snapshots, options = {}) {
  const archiveRoot = options.archiveRoot || archiveDir;
  const items = flattenComparableItems(snapshots)
    .sort((a, b) =>
      timestamp(a.capturedAt) - timestamp(b.capturedAt) ||
      String(a.itemId).localeCompare(String(b.itemId))
    );
  const previousTrustedByKey = new Map();
  const changes = [];

  for (const item of items) {
    const previous = previousTrustedByKey.get(item.comparisonKey);
    if (previous && item.captureConfidence.baselineEligible) {
      const change = await compareItems(previous, item, { ...options, archiveRoot });
      if (change) {
        changes.push(change);
      }
    }
    if (item.captureConfidence.baselineEligible) {
      previousTrustedByKey.set(item.comparisonKey, item);
    }
  }

  return changes.sort((a, b) => String(b.to.capturedAt).localeCompare(String(a.to.capturedAt)));
}

export function flattenComparableItems(snapshots) {
  const items = [];
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot || !snapshot.file || !snapshot.capturedAt) {
      continue;
    }

    items.push(createComparableItem(snapshot, null));

    for (const [index, shot] of (snapshot.relatedShots || []).entries()) {
      if (!shot?.file || (shot.isDefaultState && (shot.sectionKey === "banner" || shot.kind === "banner"))) {
        continue;
      }
      items.push(createComparableItem(snapshot, shot, index));
    }
  }
  return items.filter(Boolean);
}

export function comparisonKeyForItem(item) {
  return [
    canonicalUrl(item.url),
    item.deviceId,
    item.targetId,
    item.itemKind,
    item.sectionKey,
    item.positionKey
  ].join("|");
}

export function buildTextChange(fromItem, toItem) {
  const before = normalizeComparableText(extractText(fromItem));
  const after = normalizeComparableText(extractText(toItem));
  if (!before && !after) {
    return null;
  }
  if (before === after) {
    return null;
  }

  const blockChange = firstChangedTextBlock(extractTextBlocks(fromItem), extractTextBlocks(toItem));
  const window = blockChange || textChangeWindow(before, after);

  return {
    before: truncateText(before, 4000),
    after: truncateText(after, 4000),
    beforeFragment: truncateText(window.beforeFragment, 800),
    afterFragment: truncateText(window.afterFragment, 800),
    contextBefore: truncateText(window.contextBefore || "", 220),
    contextAfter: truncateText(window.contextAfter || "", 220),
    beforeRect: window.beforeRect || null,
    afterRect: window.afterRect || null
  };
}

export async function diffPngImages(fromPath, toPath, options = {}) {
  const settings = { ...defaultDiffOptions, ...options };
  const [fromBuffer, toBuffer] = await Promise.all([
    fs.readFile(fromPath),
    fs.readFile(toPath)
  ]);
  const fromImage = decodePng(fromBuffer);
  const toImage = decodePng(toBuffer);
  const width = Math.min(fromImage.width, toImage.width);
  const height = Math.min(fromImage.height, toImage.height);
  const comparedPixels = width * height;
  const dimensionChanged = fromImage.width !== toImage.width || fromImage.height !== toImage.height;

  if (width <= 0 || height <= 0) {
    return {
      changed: dimensionChanged,
      dimensionChanged,
      regions: dimensionChanged ? [{ x: 0, y: 0, width: toImage.width, height: toImage.height, pixels: 0 }] : [],
      changedPixels: 0,
      comparedPixels: 0,
      ratio: 0,
      width: toImage.width,
      height: toImage.height
    };
  }

  const mask = new Uint8Array(comparedPixels);
  let rawChangedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fromOffset = (y * fromImage.width + x) * 4;
      const toOffset = (y * toImage.width + x) * 4;
      const delta =
        Math.abs(fromImage.rgba[fromOffset] - toImage.rgba[toOffset]) +
        Math.abs(fromImage.rgba[fromOffset + 1] - toImage.rgba[toOffset + 1]) +
        Math.abs(fromImage.rgba[fromOffset + 2] - toImage.rgba[toOffset + 2]) +
        Math.abs(fromImage.rgba[fromOffset + 3] - toImage.rgba[toOffset + 3]);
      if (delta >= settings.pixelDeltaThreshold) {
        mask[y * width + x] = 1;
        rawChangedPixels += 1;
      }
    }
  }

  let regions = mergeRegions(
    findChangedRegions(mask, width, height)
      .filter((region) =>
        region.pixels >= settings.minRegionPixels &&
        region.width * region.height >= settings.minRegionArea
      ),
    settings.mergeGap
  );

  if (dimensionChanged && regions.length === 0) {
    regions = [{ x: 0, y: 0, width: toImage.width, height: toImage.height, pixels: rawChangedPixels }];
  }

  regions = regions
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, settings.maxRegions)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const meaningfulPixels = regions.reduce((sum, region) => sum + region.pixels, 0);
  const changed = regions.length > 0 || dimensionChanged;

  const result = {
    changed,
    dimensionChanged,
    regions,
    changedPixels: meaningfulPixels,
    rawChangedPixels,
    comparedPixels,
    ratio: comparedPixels ? meaningfulPixels / comparedPixels : 0,
    width: toImage.width,
    height: toImage.height
  };

  result.alignmentDrift = changed &&
    !result.dimensionChanged &&
    Number(result.ratio || 0) <= Number(settings.alignmentDriftMaxRatio || 0.12)
    ? detectAlignmentDrift(fromImage, toImage, width, height, settings)
    : { likely: false };

  if (changed && settings.outputPath) {
    await fs.mkdir(path.dirname(settings.outputPath), { recursive: true });
    await fs.writeFile(settings.outputPath, encodePng(toImage.width, toImage.height, markDiffImage(toImage, mask, width, regions)));
    result.outputPath = settings.outputPath;
  }

  return result;
}

async function compareItems(fromItem, toItem, options) {
  const textChange = buildTextChange(fromItem, toItem);
  const visualChange = await buildVisualChange(fromItem, toItem, options);

  if (!textChange && !visualChange) {
    return null;
  }

  const id = changeId(fromItem, toItem);
  return {
    id,
    comparisonKey: toItem.comparisonKey,
    changeType: [textChange ? "text" : "", visualChange ? "visual" : ""].filter(Boolean).join("+"),
    location: {
      url: toItem.url,
      displayUrl: toItem.displayUrl,
      targetId: toItem.targetId,
      targetLabel: toItem.targetLabel,
      devicePresetId: toItem.deviceId,
      deviceName: toItem.deviceName,
      itemKind: toItem.itemKind,
      sectionKey: toItem.sectionKey,
      sectionLabel: toItem.sectionLabel,
      sectionTitle: toItem.sectionTitle,
      label: toItem.label,
      bannerIndex: toItem.bannerIndex,
      stateIndex: toItem.stateIndex,
      stateCount: toItem.stateCount,
      tabIndex: toItem.tabIndex,
      tabLabel: toItem.tabLabel,
      pageIndex: toItem.pageIndex,
      interactionState: toItem.interactionState,
      navigationLevel: toItem.navigationLevel,
      topLevelLabel: toItem.topLevelLabel,
      topLevelIndex: toItem.topLevelIndex,
      hoverItemKey: toItem.hoverItemKey,
      hoverItemLabel: toItem.hoverItemLabel,
      hoverItemRect: toItem.hoverItemRect,
      basePageIndex: toItem.basePageIndex,
      hoverIndex: toItem.hoverIndex,
      trackIndex: toItem.trackIndex,
      trackLabel: toItem.trackLabel,
      visibleItems: toItem.visibleItems
    },
    occurredBetween: {
      from: fromItem.capturedAt,
      to: toItem.capturedAt
    },
    from: publicItemRef(fromItem),
    to: publicItemRef(toItem),
    textChange,
    visualChange,
    createdAt: toItem.capturedAt || new Date().toISOString()
  };
}

async function buildVisualChange(fromItem, toItem, options) {
  if (!fromItem.file || !toItem.file || fromItem.file === toItem.file) {
    return null;
  }
  if (fromItem.visualSignature && toItem.visualSignature && fromItem.visualSignature === toItem.visualSignature) {
    return null;
  }

  const archiveRoot = options.archiveRoot || archiveDir;
  const fromPath = path.join(archiveRoot, fromItem.file);
  const toPath = path.join(archiveRoot, toItem.file);
  const outputRelativePath = diffRelativePath(fromItem, toItem);
  const outputPath = path.join(archiveRoot, outputRelativePath);

  try {
    const diff = await diffPngImages(fromPath, toPath, {
      ...options,
      outputPath: options.writeDiffImages === false ? null : outputPath
    });
    if (!diff.changed) {
      return null;
    }
    const judgment = judgeHumanVisibleChange(fromItem, toItem, diff, options);
    if (!judgment.changed) {
      return null;
    }
    const mediaRegions = mediaItemSignalRegions(judgment.signals, diff.width, diff.height);
    if (diff.outputPath && mediaRegions.length) {
      await markAdditionalRegions(diff.outputPath, mediaRegions);
    }
    const regions = [...diff.regions, ...mediaRegions];
    return {
      diffFile: diff.outputPath ? outputRelativePath : null,
      diffImageUrl: diff.outputPath ? publicSnapshotUrl(outputRelativePath) : null,
      regionCount: regions.length,
      regions,
      changedPixels: diff.changedPixels,
      rawChangedPixels: diff.rawChangedPixels,
      comparedPixels: diff.comparedPixels,
      ratio: Number(diff.ratio.toFixed(6)),
      width: diff.width,
      height: diff.height,
      dimensionChanged: diff.dimensionChanged,
      judgment: judgment.kind,
      signals: judgment.signals,
      summary: judgment.summary
    };
  } catch (error) {
    if (options.recordVisualSkips) {
      return {
        diffFile: null,
        diffImageUrl: null,
        regionCount: 0,
        regions: [],
        changedPixels: 0,
        rawChangedPixels: 0,
        comparedPixels: 0,
        ratio: 0,
        width: null,
        height: null,
        dimensionChanged: false,
        skipped: true,
        reason: error.message
      };
    }
    return null;
  }
}

export function judgeHumanVisibleChange(fromItem, toItem, diff, options = {}) {
  const settings = { ...defaultVisualJudgmentOptions, ...options };
  const signals = [];
  const beforeText = normalizeComparableText(extractText(fromItem));
  const afterText = normalizeComparableText(extractText(toItem));
  const textChanged = Boolean(beforeText || afterText) && beforeText !== afterText;
  if (textChanged) {
    signals.push({ type: "copy", label: "copy changed" });
  }

  const assetChange = imageAssetChange(fromItem, toItem);
  if (assetChange.changed) {
    signals.push({
      type: "image",
      label: "image asset changed",
      before: assetChange.before,
      after: assetChange.after
    });
  }

  signals.push(...mediaItemChangeSignals(fromItem, toItem, settings));
  signals.push(...productHoverChangeSignals(fromItem, toItem));

  const layoutChange = layoutChangeForTextBlocks(fromItem, toItem, settings);
  if (layoutChange.changed) {
    signals.push({
      type: "layout",
      label: "content position changed",
      text: truncateText(layoutChange.text, 180),
      beforeRect: layoutChange.beforeRect,
      afterRect: layoutChange.afterRect,
      deltaX: layoutChange.deltaX,
      deltaY: layoutChange.deltaY
    });
  }

  if (diff.dimensionChanged) {
    signals.push({ type: "dimension", label: "image dimensions changed" });
  }

  const semanticSignals = signals.filter((signal) => signal.type !== "dimension");
  if (semanticSignals.length > 0 || diff.dimensionChanged) {
    return {
      changed: true,
      kind: semanticSignals.length > 0 ? "semantic" : "dimension",
      signals,
      summary: summarizeSignals(signals)
    };
  }

  const minRatio = minVisualRatioForItem(toItem, settings);
  if (isLikelyAlignmentDrift(diff, minRatio)) {
    return {
      changed: false,
      kind: "suppressed-drift",
      signals: [],
      summary: "only alignment drift; code metadata stayed the same"
    };
  }

  if (Number(diff.ratio || 0) >= minRatio) {
    const signal = {
      type: "large-visual",
      label: "large visual change",
      ratio: Number(diff.ratio.toFixed(6))
    };
    return {
      changed: true,
      kind: "large-visual",
      signals: [signal],
      summary: summarizeSignals([signal])
    };
  }

  return {
    changed: false,
    kind: "suppressed-drift",
    signals: [],
    summary: "only pixel drift; text, image assets, and layout stayed the same"
  };
}

function createComparableItem(snapshot, shot, relatedIndex = null) {
  const isRelated = Boolean(shot);
  const isTopLevelBanner = !isRelated && Number(snapshot.bannerIndex || 0) > 0;
  const source = shot || snapshot;
  const itemKind = isRelated || isTopLevelBanner ? "section" : "page";
  const sectionKey = itemKind === "page"
    ? "page"
    : source.sectionKey || (source.bannerIndex ? "banner" : "section");
  const stateIndex = numberOrNull(source.stateIndex);
  const bannerIndex = numberOrNull(source.bannerIndex);
  const pageIndex = numberOrNull(source.pageIndex);
  const tabIndex = numberOrNull(source.tabIndex);
  const interactionState = source.interactionState || source.sectionState?.interactionState || "default";
  const navigationLevel = source.navigationLevel || source.sectionState?.navigationLevel || null;
  const topLevelLabel = source.topLevelLabel || source.sectionState?.topLevelLabel || null;
  const topLevelIndex = numberOrNull(source.topLevelIndex || source.sectionState?.topLevelIndex);
  const hoverItemKey = source.hoverItemKey || source.sectionState?.hoverItemKey || null;
  const hoverItemLabel = source.hoverItemLabel || source.sectionState?.hoverItemLabel || null;
  const hoverItemRect = source.hoverItemRect || source.sectionState?.hoverItemRect || null;
  const basePageIndex = numberOrNull(source.basePageIndex || source.sectionState?.basePageIndex);
  const hoverIndex = numberOrNull(source.hoverIndex || source.sectionState?.hoverIndex);
  const positionKey = positionKeyForSource({
    itemKind,
    sectionKey,
    stateIndex,
    bannerIndex,
    pageIndex,
    tabIndex,
    interactionState,
    hoverItemKey,
    basePageIndex,
    hoverIndex,
    relatedIndex
  });
  const item = {
    itemId: isRelated
      ? `${snapshot.id || snapshot.capturedAt}::related::${relatedIndex}`
      : `${snapshot.id || snapshot.capturedAt}::snapshot`,
    snapshotId: snapshot.id || "",
    url: snapshot.url || snapshot.requestedUrl || snapshot.finalUrl || "",
    displayUrl: snapshot.displayUrl || snapshot.targetLabel || snapshot.url || "",
    targetId: snapshot.targetId || snapshot.captureMode || "target",
    targetLabel: snapshot.targetLabel || "",
    deviceId: snapshot.devicePresetId || deviceSizeId(snapshot),
    deviceName: snapshot.deviceName || snapshot.deviceLabel || "",
    capturedAt: snapshot.capturedAt,
    file: source.file || "",
    imageUrl: source.imageUrl || publicSnapshotUrl(source.file || ""),
    width: source.width || snapshot.width || null,
    height: source.height || snapshot.height || null,
    itemKind,
    sectionKey,
    sectionLabel: itemKind === "page" ? "Page" : source.sectionLabel || (sectionKey === "banner" ? "Banner" : ""),
    sectionTitle: itemKind === "page" ? "Full page" : source.sectionTitle || source.sectionLabel || "",
    label: itemKind === "page" ? snapshot.displayUrl || snapshot.url || "Page" : source.label || source.stateLabel || "",
    stateIndex,
    stateCount: numberOrNull(source.stateCount || source.bannerCount),
    bannerIndex,
    tabIndex,
    tabLabel: source.tabLabel || null,
    pageIndex,
    interactionState,
    navigationLevel,
    topLevelLabel,
    topLevelIndex,
    hoverItemKey,
    hoverItemLabel,
    hoverItemRect,
    basePageIndex,
    hoverIndex,
    trackIndex: numberOrNull(source.trackIndex || source.tabIndex),
    trackLabel: source.trackLabel || source.tabLabel || null,
    itemCount: numberOrNull(source.itemCount),
    visibleItemCount: numberOrNull(source.visibleItemCount),
    visibleItems: Array.isArray(source.visibleItems) ? source.visibleItems : null,
    itemRects: Array.isArray(source.itemRects) ? source.itemRects : null,
    visualSignature: source.visualSignature || null,
    visualHash: source.visualHash || null,
    visualAudit: source.visualAudit || snapshot.visualAudit || null,
    logicalSignature: source.logicalSignature || source.bannerSignature || null,
    bannerState: source.bannerState || null,
    sectionState: source.sectionState || null,
    positionKey
  };
  item.captureConfidence = normalizeCaptureConfidence(source.captureConfidence || snapshot.captureConfidence);
  item.comparisonKey = comparisonKeyForItem(item);
  return item;
}

function positionKeyForSource({
  itemKind,
  sectionKey,
  stateIndex,
  bannerIndex,
  pageIndex,
  tabIndex,
  interactionState,
  hoverItemKey,
  basePageIndex,
  hoverIndex,
  relatedIndex
}) {
  if (itemKind === "page") {
    return "page";
  }
  if (bannerIndex) {
    return `banner:${bannerIndex}`;
  }
  if (interactionState === "hover") {
    return [
      sectionKey,
      "tab",
      tabIndex ?? "",
      "hover",
      hoverItemKey || hoverIndex || basePageIndex || relatedIndex || ""
    ].join(":");
  }
  if (pageIndex || tabIndex !== null) {
    return `${sectionKey}:tab:${tabIndex ?? ""}:page:${pageIndex ?? ""}`;
  }
  if (stateIndex) {
    return `${sectionKey}:state:${stateIndex}`;
  }
  return `related:${relatedIndex ?? 0}:${sectionKey}`;
}

function publicItemRef(item) {
  return {
    snapshotId: item.snapshotId,
    itemId: item.itemId,
    capturedAt: item.capturedAt,
    file: item.file,
    imageUrl: item.imageUrl,
    width: item.width,
    height: item.height,
    text: truncateText(normalizeComparableText(extractText(item)), 2000),
    visibleItems: item.visibleItems || item.sectionState?.visibleItems || null,
    interactionState: item.interactionState || "default",
    hoverItemKey: item.hoverItemKey || null,
    hoverItemLabel: item.hoverItemLabel || null,
    hoverItemRect: item.hoverItemRect || null,
    captureConfidence: item.captureConfidence
  };
}

function extractText(item) {
  return item.sectionState?.text || item.bannerState?.text || item.text || "";
}

function extractTextBlocks(item) {
  const blocks = item.sectionState?.textBlocks || item.bannerState?.textBlocks || [];
  return Array.isArray(blocks)
    ? blocks
      .map((block) => ({
        text: normalizeComparableText(block.text),
        rect: normalizeRect(block)
      }))
      .filter((block) => block.text)
    : [];
}

function extractImageSources(item) {
  const state = item.sectionState || item.bannerState || {};
  const images = Array.isArray(state.images) ? state.images : [];
  const backgrounds = Array.isArray(state.backgrounds) ? state.backgrounds : [];
  const parsed = parseLogicalSignature(item.logicalSignature);
  const parsedImages = Array.isArray(parsed?.images) ? parsed.images : [];
  const parsedBackgrounds = Array.isArray(parsed?.backgrounds) ? parsed.backgrounds : [];
  return [...images, ...backgrounds, ...parsedImages, ...parsedBackgrounds]
    .map((source) => String(source || "").trim())
    .filter(Boolean);
}

function imageAssetChange(fromItem, toItem) {
  const before = imageAssetFingerprint(fromItem);
  const after = imageAssetFingerprint(toItem);
  if (before.families.size === 0 || after.families.size === 0) {
    return { changed: false, before: [...before.families], after: [...after.families] };
  }

  const exactOverlap = intersectionSize(before.exact, after.exact);
  const familyOverlap = intersectionSize(before.families, after.families);
  const overlap = Math.max(exactOverlap, familyOverlap);
  const minSize = Math.max(1, Math.min(before.families.size, after.families.size));
  const changed = overlap === 0 || overlap / minSize < 0.5;
  return {
    changed,
    before: [...before.families],
    after: [...after.families]
  };
}

function imageAssetFingerprint(item) {
  const exact = new Set();
  const families = new Set();
  for (const source of extractImageSources(item)) {
    const key = imageAssetKey(source);
    if (!key) {
      continue;
    }
    exact.add(key.exact);
    families.add(key.family);
  }
  return { exact, families };
}

function imageAssetKey(source) {
  const firstCandidate = String(source || "").split(",")[0].trim().split(/\s+/)[0];
  if (!firstCandidate) {
    return null;
  }
  try {
    const url = new URL(firstCandidate, "https://asset.local");
    const basename = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    const exact = basename
      .toLowerCase()
      .replace(/\.(avif|webp|png|jpe?g|gif|svg)$/i, "")
      .replace(/@[\dx]+$/i, "")
      .replace(/[-_]\d{2,5}w$/i, "")
      .replace(/[-_]\d+x\d+$/i, "");
    const family = exact
      .replace(/^m[-_]/i, "")
      .replace(/[-_](mb|mobile|desktop|pc)$/i, "");
    return exact ? { exact, family: family || exact } : null;
  } catch {
    return null;
  }
}

function productHoverChangeSignals(fromItem, toItem) {
  if (toItem.sectionKey !== "product-showcase" || toItem.interactionState !== "hover") {
    return [];
  }
  const key = toItem.hoverItemKey || toItem.sectionState?.hoverItemKey || "";
  const beforeKey = fromItem.hoverItemKey || fromItem.sectionState?.hoverItemKey || "";
  const label = toItem.hoverItemLabel || toItem.sectionState?.hoverItemLabel || toItem.label || key || "product";
  if (!key && !label) {
    return [];
  }
  return [{
    type: "product-hover-item",
    label: `hover product changed: ${label}`,
    reason: beforeKey && key && beforeKey !== key ? "hover item identity changed" : "hover visual changed",
    hoverItemKey: key || null,
    hoverItemLabel: label,
    beforeHoverItemKey: beforeKey || null,
    rect: toItem.hoverItemRect || toItem.sectionState?.hoverItemRect || null
  }];
}

function mediaItemChangeSignals(fromItem, toItem, settings) {
  if (toItem.sectionKey !== "media") {
    return [];
  }

  const beforeItems = mediaComparableItems(fromItem);
  const afterItems = mediaComparableItems(toItem);
  if (!afterItems.length) {
    return [];
  }

  const beforeById = new Map(beforeItems.map((item) => [item.id, item]));
  const beforeBySlot = new Map(beforeItems.map((item, index) => [mediaItemSlotKey(item, index), item]));
  const matchedBefore = new Set();
  const signals = [];
  const signaled = new Set();
  const addSignal = (item, reason, before = null) => {
    const key = item.id || item.label || reason;
    if (!key || signaled.has(key)) {
      return;
    }
    signaled.add(key);
    signals.push({
      type: "media-item",
      label: `media item changed: ${item.label || item.id}`,
      reason,
      mediaItemId: item.id,
      mediaItemLabel: item.label,
      beforeMediaItemId: before?.id || null,
      beforeMediaItemLabel: before?.label || null,
      rect: item.rect || null
    });
  };

  for (const [index, item] of afterItems.entries()) {
    const before = beforeById.get(item.id) || beforeBySlot.get(mediaItemSlotKey(item, index));
    if (!before) {
      addSignal(item, "added or moved into this window");
      continue;
    }
    matchedBefore.add(before.id);
    const codeChange = mediaItemCodeChange(before, item, settings);
    if (codeChange.changed) {
      addSignal(item, codeChange.reason, before);
    }
  }
  for (const item of beforeItems) {
    if (!matchedBefore.has(item.id)) {
      addSignal(item, "removed from this window");
    }
  }

  return signals;
}

function mediaItemSignalRegions(signals, width, height) {
  return (signals || [])
    .filter((signal) => signal?.type === "media-item" || signal?.type === "product-hover-item")
    .map((signal) => {
      const rect = normalizeRect(signal.rect);
      if (!rect) {
        return null;
      }
      const x = Math.max(0, Math.min(width, rect.x));
      const y = Math.max(0, Math.min(height, rect.y));
      const right = Math.max(x, Math.min(width, rect.x + rect.width));
      const bottom = Math.max(y, Math.min(height, rect.y + rect.height));
      if (right <= x || bottom <= y) {
        return null;
      }
      return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(right - x),
        height: Math.round(bottom - y),
        pixels: 0,
        source: signal.type,
        mediaItemId: signal.mediaItemId || null,
        mediaItemLabel: signal.mediaItemLabel || null,
        hoverItemKey: signal.hoverItemKey || null,
        hoverItemLabel: signal.hoverItemLabel || null
      };
    })
    .filter(Boolean);
}

function mediaComparableItems(item) {
  const state = item.sectionState || {};
  const sourceItems = Array.isArray(item.visibleItems)
    ? item.visibleItems
    : (Array.isArray(state.visibleItems) ? state.visibleItems : []);
  const sourceRects = Array.isArray(item.itemRects)
    ? item.itemRects
    : (Array.isArray(state.itemRects) ? state.itemRects : []);
  const rectById = new Map();
  for (const itemRect of sourceRects) {
    const id = String(itemRect?.mediaItemId || itemRect?.key || "");
    const rect = normalizeRect(itemRect?.rect || itemRect);
    if (id && rect) {
      rectById.set(id, rect);
    }
  }

  return sourceItems
    .map((source, index) => {
      const id = String(source?.mediaItemId || source?.key || source?.id || "");
      const rect = normalizeRect(source?.rect) || rectById.get(id) || null;
      const imageFamily = source?.imageFamily || mediaItemImageFamily(source?.image);
      return {
        id: id || `${item.sectionKey || "media"}:${item.tabIndex || ""}:${index}`,
        key: String(source?.key || source?.mediaItemId || source?.id || ""),
        label: source?.label || source?.title || source?.text || imageFamily || `item ${index + 1}`,
        text: source?.text || "",
        imageFamily,
        position: numberOrNull(source?.position),
        index,
        rect
      };
    })
    .filter((source) => source.id);
}

function mediaItemImageFamily(source) {
  const key = imageAssetKey(source);
  return key?.family || "";
}

function mediaItemSlotKey(item, index) {
  if (Number.isFinite(Number(item.position))) {
    return `position:${Number(item.position)}`;
  }
  const rect = normalizeRect(item.rect);
  if (rect) {
    return `rect:${Math.round(rect.x / 8)}:${Math.round(rect.y / 8)}`;
  }
  return `index:${index}`;
}

function mediaItemCodeChange(before, after, settings) {
  if (before.imageFamily && after.imageFamily && before.imageFamily !== after.imageFamily) {
    return { changed: true, reason: "image asset changed" };
  }
  if (normalizeComparableText(before.label) !== normalizeComparableText(after.label)) {
    return { changed: true, reason: "label changed" };
  }
  if (normalizeComparableText(before.text) !== normalizeComparableText(after.text)) {
    return { changed: true, reason: "text changed" };
  }
  if (Number.isFinite(Number(before.position)) && Number.isFinite(Number(after.position)) && Number(before.position) !== Number(after.position)) {
    return { changed: true, reason: "item position changed" };
  }
  if (Number.isFinite(Number(before.index)) && Number.isFinite(Number(after.index)) && Number(before.index) !== Number(after.index)) {
    return { changed: true, reason: "item order changed" };
  }
  if (mediaItemRectChanged(before.rect, after.rect, settings)) {
    return { changed: true, reason: "item rect changed" };
  }
  if (before.id && after.id && before.id !== after.id) {
    return { changed: true, reason: "item identity changed" };
  }
  return { changed: false };
}

function mediaItemRectChanged(beforeRect, afterRect, settings) {
  const before = normalizeRect(beforeRect);
  const after = normalizeRect(afterRect);
  if (!before && !after) {
    return false;
  }
  if (!before || !after) {
    return true;
  }
  const beforeCenter = rectCenter(before);
  const afterCenter = rectCenter(after);
  const deltaX = Math.abs(afterCenter.x - beforeCenter.x);
  const deltaY = Math.abs(afterCenter.y - beforeCenter.y);
  const moveThreshold = Math.max(1, Number(settings.mediaRectMoveMinPixels || 8));
  if (deltaX >= moveThreshold || deltaY >= moveThreshold) {
    return true;
  }
  return rectResizeRatio(before, after) >= Number(settings.mediaRectResizeRatio || 0.08);
}

function layoutChangeForTextBlocks(fromItem, toItem, settings) {
  const beforeBlocks = extractTextBlocks(fromItem);
  const afterBlocks = extractTextBlocks(toItem);
  if (!beforeBlocks.length || !afterBlocks.length) {
    return { changed: false };
  }

  const beforeByText = new Map();
  for (const block of beforeBlocks) {
    if (!beforeByText.has(block.text)) {
      beforeByText.set(block.text, block);
    }
  }

  const itemWidth = Math.max(Number(fromItem.width || 0), Number(toItem.width || 0), 1);
  const itemHeight = Math.max(Number(fromItem.height || 0), Number(toItem.height || 0), 1);
  const moveXThreshold = Math.max(settings.layoutMoveMinPixels, itemWidth * settings.layoutMoveMinRatio);
  const moveYThreshold = Math.max(settings.layoutMoveMinPixels, itemHeight * settings.layoutMoveMinRatio);

  for (const afterBlock of afterBlocks) {
    const beforeBlock = beforeByText.get(afterBlock.text);
    if (!beforeBlock?.rect || !afterBlock.rect) {
      continue;
    }

    const beforeCenter = rectCenter(beforeBlock.rect);
    const afterCenter = rectCenter(afterBlock.rect);
    const deltaX = Math.round(afterCenter.x - beforeCenter.x);
    const deltaY = Math.round(afterCenter.y - beforeCenter.y);
    const moved = Math.abs(deltaX) >= moveXThreshold || Math.abs(deltaY) >= moveYThreshold;
    const resized = rectResizeRatio(beforeBlock.rect, afterBlock.rect) >= settings.layoutResizeRatio;
    if (moved || resized) {
      return {
        changed: true,
        text: afterBlock.text,
        beforeRect: beforeBlock.rect,
        afterRect: afterBlock.rect,
        deltaX,
        deltaY
      };
    }
  }

  return { changed: false };
}

function minVisualRatioForItem(item, settings) {
  if (item.sectionKey === "banner" || item.bannerIndex) {
    return settings.bannerMinRatio;
  }
  if (item.itemKind === "section") {
    return settings.sectionMinRatio;
  }
  return settings.pageMinRatio;
}

function isLikelyAlignmentDrift(diff, minRatio) {
  const drift = diff.alignmentDrift;
  if (!drift?.likely || diff.dimensionChanged) {
    return false;
  }
  if (Number(diff.ratio || 0) >= minRatio && Number(drift.bestRatio || 0) >= minRatio) {
    return false;
  }
  return true;
}

function summarizeSignals(signals) {
  return signals.map((signal) => signal.label).filter(Boolean).join(", ");
}

function parseLogicalSignature(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function rectCenter(rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

function rectResizeRatio(beforeRect, afterRect) {
  const beforeArea = Math.max(1, beforeRect.width * beforeRect.height);
  const afterArea = Math.max(1, afterRect.width * afterRect.height);
  return Math.abs(afterArea - beforeArea) / Math.max(beforeArea, afterArea);
}

function detectAlignmentDrift(fromImage, toImage, width, height, settings) {
  if (fromImage.width !== toImage.width || fromImage.height !== toImage.height || width <= 0 || height <= 0) {
    return { likely: false };
  }

  const maxShift = Math.max(0, Math.floor(Number(settings.alignmentDriftMaxShift || 0)));
  if (maxShift <= 0) {
    return { likely: false };
  }

  const maxSamples = Math.max(1000, Number(settings.alignmentDriftSamplePixels || 20000));
  const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxSamples)));
  const zero = shiftedSampleDifference(fromImage, toImage, width, height, 0, 0, stride, settings.pixelDeltaThreshold);
  if (!zero.count || zero.ratio === 0) {
    return { likely: false, zeroRatio: zero.ratio || 0 };
  }

  let best = zero;
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const candidate = shiftedSampleDifference(fromImage, toImage, width, height, dx, dy, stride, settings.pixelDeltaThreshold);
      if (candidate.count && candidate.ratio < best.ratio) {
        best = candidate;
      }
    }
  }

  const improvement = zero.ratio > 0 ? (zero.ratio - best.ratio) / zero.ratio : 0;
  return {
    likely: (best.dx !== 0 || best.dy !== 0) && improvement >= Number(settings.alignmentDriftImprovementRatio || 0.25),
    dx: best.dx,
    dy: best.dy,
    zeroRatio: Number(zero.ratio.toFixed(6)),
    bestRatio: Number(best.ratio.toFixed(6)),
    improvement: Number(improvement.toFixed(6)),
    stride
  };
}

function shiftedSampleDifference(fromImage, toImage, width, height, dx, dy, stride, threshold) {
  let changed = 0;
  let count = 0;
  const startX = Math.max(0, -dx);
  const endX = Math.min(width, width - dx);
  const startY = Math.max(0, -dy);
  const endY = Math.min(height, height - dy);
  for (let y = startY; y < endY; y += stride) {
    for (let x = startX; x < endX; x += stride) {
      const fromOffset = (y * fromImage.width + x) * 4;
      const toOffset = ((y + dy) * toImage.width + x + dx) * 4;
      const delta =
        Math.abs(fromImage.rgba[fromOffset] - toImage.rgba[toOffset]) +
        Math.abs(fromImage.rgba[fromOffset + 1] - toImage.rgba[toOffset + 1]) +
        Math.abs(fromImage.rgba[fromOffset + 2] - toImage.rgba[toOffset + 2]) +
        Math.abs(fromImage.rgba[fromOffset + 3] - toImage.rgba[toOffset + 3]);
      if (delta >= threshold) {
        changed += 1;
      }
      count += 1;
    }
  }
  return {
    dx,
    dy,
    changed,
    count,
    ratio: count ? changed / count : 0
  };
}

function firstChangedTextBlock(beforeBlocks, afterBlocks) {
  if (!beforeBlocks.length || !afterBlocks.length) {
    return null;
  }
  const length = Math.max(beforeBlocks.length, afterBlocks.length);
  for (let index = 0; index < length; index += 1) {
    const before = beforeBlocks[index]?.text || "";
    const after = afterBlocks[index]?.text || "";
    if (before !== after) {
      return {
        beforeFragment: before,
        afterFragment: after,
        contextBefore: before,
        contextAfter: after,
        beforeRect: beforeBlocks[index]?.rect || null,
        afterRect: afterBlocks[index]?.rect || null
      };
    }
  }
  return null;
}

export function textChangeWindow(before, after) {
  let prefix = 0;
  const minLength = Math.min(before.length, after.length);
  while (prefix < minLength && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < minLength - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeStart = wordStart(before, prefix);
  const afterStart = wordStart(after, prefix);
  const beforeEnd = wordEnd(before, Math.max(beforeStart, before.length - suffix));
  const afterEnd = wordEnd(after, Math.max(afterStart, after.length - suffix));

  return {
    beforeFragment: before.slice(beforeStart, beforeEnd).trim(),
    afterFragment: after.slice(afterStart, afterEnd).trim(),
    contextBefore: before.slice(Math.max(0, beforeStart - 80), Math.min(before.length, beforeEnd + 80)).trim(),
    contextAfter: after.slice(Math.max(0, afterStart - 80), Math.min(after.length, afterEnd + 80)).trim()
  };
}

function normalizeComparableText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRect(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  const rect = {
    x: Math.round(Number(input.x) || 0),
    y: Math.round(Number(input.y) || 0),
    width: Math.round(Number(input.width) || 0),
    height: Math.round(Number(input.height) || 0)
  };
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function findChangedRegions(mask, width, height) {
  const regions = [];
  const queue = new Int32Array(width * height);
  const pushIfChanged = (index, state) => {
    if (index < 0 || index >= mask.length || mask[index] !== 1) {
      return state;
    }
    mask[index] = 2;
    queue[state.tail] = index;
    state.tail += 1;
    return state;
  };

  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 1) {
      continue;
    }

    let state = { head: 0, tail: 0 };
    state = pushIfChanged(index, state);
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let pixels = 0;

    while (state.head < state.tail) {
      const current = queue[state.head];
      state.head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      pixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      if (x > 0) state = pushIfChanged(current - 1, state);
      if (x < width - 1) state = pushIfChanged(current + 1, state);
      if (y > 0) state = pushIfChanged(current - width, state);
      if (y < height - 1) state = pushIfChanged(current + width, state);
    }

    regions.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      pixels
    });
  }

  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 2) {
      mask[index] = 1;
    }
  }

  return regions;
}

function mergeRegions(regions, gap) {
  const merged = [];
  for (const region of regions) {
    let target = merged.find((candidate) => regionsTouch(candidate, region, gap));
    if (!target) {
      merged.push({ ...region });
      continue;
    }
    mergeRegionInto(target, region);
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        const candidate = merged[index];
        if (candidate === target || !regionsTouch(target, candidate, gap)) {
          continue;
        }
        mergeRegionInto(target, candidate);
        merged.splice(index, 1);
        changed = true;
      }
    }
  }
  return merged;
}

function regionsTouch(a, b, gap) {
  return a.x <= b.x + b.width + gap &&
    b.x <= a.x + a.width + gap &&
    a.y <= b.y + b.height + gap &&
    b.y <= a.y + a.height + gap;
}

function mergeRegionInto(target, source) {
  const minX = Math.min(target.x, source.x);
  const minY = Math.min(target.y, source.y);
  const maxX = Math.max(target.x + target.width, source.x + source.width);
  const maxY = Math.max(target.y + target.height, source.y + source.height);
  target.x = minX;
  target.y = minY;
  target.width = maxX - minX;
  target.height = maxY - minY;
  target.pixels += source.pixels;
}

function markDiffImage(toImage, mask, maskWidth, regions) {
  const output = new Uint8Array(toImage.rgba);
  const maskHeight = maskWidth ? Math.floor(mask.length / maskWidth) : 0;
  for (const region of regions) {
    const endY = Math.min(toImage.height, region.y + region.height);
    const endX = Math.min(toImage.width, region.x + region.width);
    for (let y = Math.max(0, region.y); y < endY; y += 1) {
      for (let x = Math.max(0, region.x); x < endX; x += 1) {
        if (x >= maskWidth || y >= maskHeight || y * maskWidth + x >= mask.length || mask[y * maskWidth + x] !== 1) {
          continue;
        }
        const offset = (y * toImage.width + x) * 4;
        output[offset] = Math.round(output[offset] * 0.45 + 225 * 0.55);
        output[offset + 1] = Math.round(output[offset + 1] * 0.45 + 29 * 0.55);
        output[offset + 2] = Math.round(output[offset + 2] * 0.45 + 72 * 0.55);
        output[offset + 3] = 255;
      }
    }
    drawBox(output, toImage.width, toImage.height, region, [225, 29, 72, 255]);
  }
  return output;
}

async function markAdditionalRegions(filePath, regions) {
  const image = decodePng(await fs.readFile(filePath));
  const output = new Uint8Array(image.rgba);
  for (const region of regions) {
    drawBox(output, image.width, image.height, region, [255, 107, 53, 255]);
  }
  await fs.writeFile(filePath, encodePng(image.width, image.height, output));
}

function drawBox(rgba, width, height, region, color) {
  const x1 = Math.max(0, region.x - 2);
  const y1 = Math.max(0, region.y - 2);
  const x2 = Math.min(width - 1, region.x + region.width + 1);
  const y2 = Math.min(height - 1, region.y + region.height + 1);
  for (let thickness = 0; thickness < 3; thickness += 1) {
    for (let x = x1; x <= x2; x += 1) {
      setPixel(rgba, width, x, Math.min(height - 1, y1 + thickness), color);
      setPixel(rgba, width, x, Math.max(0, y2 - thickness), color);
    }
    for (let y = y1; y <= y2; y += 1) {
      setPixel(rgba, width, Math.min(width - 1, x1 + thickness), y, color);
      setPixel(rgba, width, Math.max(0, x2 - thickness), y, color);
    }
  }
}

function setPixel(rgba, width, x, y, color) {
  const offset = (y * width + x) * 4;
  rgba[offset] = color[0];
  rgba[offset + 1] = color[1];
  rgba[offset + 2] = color[2];
  rgba[offset + 3] = color[3];
}

function diffRelativePath(fromItem, toItem) {
  const day = String(toItem.capturedAt || new Date().toISOString()).slice(0, 10);
  const site = siteSlug(toItem.url || toItem.displayUrl || "site");
  const digest = crypto.createHash("sha1")
    .update(`${fromItem.itemId}|${toItem.itemId}|${fromItem.file}|${toItem.file}`)
    .digest("hex")
    .slice(0, 12);
  return path.posix.join("diffs", day, site, `${timestampStamp(toItem.capturedAt)}-${safeFilePart(toItem.sectionKey)}-${digest}.png`);
}

function changeId(fromItem, toItem) {
  return crypto.createHash("sha1")
    .update(`${fromItem.comparisonKey}|${fromItem.capturedAt}|${toItem.capturedAt}|${fromItem.file}|${toItem.file}`)
    .digest("hex");
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function deviceSizeId(snapshot) {
  return `custom-${snapshot.width || 0}x${snapshot.scrollInfo?.viewportHeight || snapshot.height || 0}`;
}

function siteSlug(value) {
  try {
    return safeFilePart(new URL(value).hostname.replace(/^www\./, ""));
  } catch {
    return safeFilePart(value);
  }
}

function timestampStamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
}

function safeFilePart(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestamp(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function truncateText(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function wordStart(text, index) {
  let current = Math.max(0, Math.min(text.length, index));
  while (current > 0 && !/\s/.test(text[current - 1])) {
    current -= 1;
  }
  return current;
}

function wordEnd(text, index) {
  let current = Math.max(0, Math.min(text.length, index));
  while (current < text.length && !/\s/.test(text[current])) {
    current += 1;
  }
  return current;
}
