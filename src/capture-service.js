import fs from "node:fs/promises";
import path from "node:path";
import { capturePage, findBrowser } from "./browser.js";
import { rebuildChanges } from "./changes.js";
import { devicePresets, findDevicePreset, toPublicDevicePreset } from "./device-presets.js";
import { archiveDir } from "./paths.js";
import {
  appendSnapshot,
  createSnapshotFilePath,
  loadConfig,
  normalizeCaptureTarget,
  normalizeConfig,
  publicSnapshotUrl
} from "./store.js";

export async function captureConfiguredUrls(config = null) {
  const activeConfig = config || await loadConfig();
  const results = [];
  for (const target of activeConfig.urls) {
    results.push(await captureOne(target, activeConfig));
  }
  return results;
}

export async function captureAllDevices(config = null) {
  const activeConfig = config || await loadConfig();
  const results = [];
  for (const preset of devicePresets) {
    const presetConfig = normalizeConfig({
      ...activeConfig,
      devicePresetId: preset.id
    });
    for (const target of presetConfig.urls) {
      results.push(await captureOne(target, presetConfig));
    }
  }
  return results;
}

export async function captureOne(inputTarget, config = null) {
  const activeConfig = config || await loadConfig();
  const target = normalizeCaptureTarget(inputTarget);
  const normalizedUrl = target.url;
  const capturedAt = new Date();
  const fileInfo = await createSnapshotFilePath(normalizedUrl, capturedAt);
  const devicePreset = findDevicePreset(activeConfig.devicePresetId);
  const publicDevice = devicePreset ? toPublicDevicePreset(devicePreset) : null;
  const captureConfig = captureConfigForTarget(activeConfig, target);

  try {
    const capture = await capturePage(normalizedUrl, fileInfo.absolutePath, captureConfig);
    const relatedCapture = await captureRelatedShotsForTarget(target, normalizedUrl, fileInfo.absolutePath, captureConfig);
    const relatedShots = relatedCapture.shots;
    const stamp = capturedAt.toISOString().replace(/[:.]/g, "-");
    const targetLabel = target.label || normalizedUrl;
    const captureItems = Array.isArray(capture.captures) && capture.captures.length
      ? capture.captures
      : [capture];
    const snapshots = [];

    for (const item of captureItems) {
      const absolutePath = item.outputPath || fileInfo.absolutePath;
      const relativePath = absolutePath === fileInfo.absolutePath
        ? fileInfo.relativePath
        : archiveRelativePath(absolutePath);
      const stat = await fs.stat(absolutePath);
      const itemTargetId = item.bannerIndex ? `${target.id}-banner-${item.bannerIndex}` : target.id;
      const itemTargetLabel = item.bannerIndex ? `\u9996\u9875 Banner ${item.bannerIndex}` : targetLabel;
      const displayUrl = item.bannerIndex ? bannerDisplayLabel(targetLabel, item.bannerIndex) : targetLabel;
      const snapshot = await appendSnapshot({
        id: `${stamp}-${fileInfo.siteSlug}-${itemTargetId}-${publicDevice?.id || "device"}`,
        url: normalizedUrl,
        targetId: itemTargetId,
        targetLabel: itemTargetLabel,
        displayUrl,
        captureMode: target.captureMode || null,
        requestedUrl: capture.requestedUrl || normalizedUrl,
        finalUrl: capture.finalUrl || normalizedUrl,
        urlCheck: capture.urlCheck || null,
        title: capture.title,
        capturedAt: capturedAt.toISOString(),
        file: relativePath,
        imageUrl: publicSnapshotUrl(relativePath),
        bytes: stat.size,
        width: item.width || capture.width,
        height: item.height || capture.height,
        devicePresetId: publicDevice?.id || activeConfig.devicePresetId || null,
        deviceName: publicDevice?.name || null,
        deviceLabel: publicDevice?.label || null,
        fullPageHeight: capture.fullPageHeight,
        truncated: capture.truncated,
        scrollInfo: capture.scrollInfo,
        browserPath: capture.browserPath,
        bannerIndex: item.bannerIndex || null,
        bannerCount: item.bannerCount || null,
        bannerSignature: item.bannerSignature || null,
        visualSignature: item.visualSignature || null,
        bannerClip: item.bannerClip || null,
        bannerState: item.bannerState || null,
        bannerValidation: item.bannerIndex ? capture.bannerInfo || null : null,
        relatedValidation: !item.bannerIndex ? relatedCapture.validation : null,
        relatedShots: !item.bannerIndex && relatedShots.length ? relatedShots : null
      });
      snapshots.push(snapshot);
    }

    const changeRefresh = await refreshChangeRecords();
    return { ok: true, snapshot: snapshots[0], snapshots, changeRefresh };
  } catch (error) {
    await removeCaptureOutputs(fileInfo.absolutePath);
    return {
      ok: false,
      url: normalizedUrl,
      targetId: target.id,
      targetLabel: target.label || normalizedUrl,
      displayUrl: target.label || normalizedUrl,
      captureMode: target.captureMode || null,
      requestedUrl: error.requestedUrl || normalizedUrl,
      finalUrl: error.finalUrl || null,
      urlCheck: error.urlCheck || null,
      capturedAt: capturedAt.toISOString(),
      error: error.message
    };
  }
}

async function refreshChangeRecords() {
  try {
    const changes = await rebuildChanges();
    return { ok: true, count: changes.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function captureConfigForTarget(config, target) {
  const targetConfig = { ...config };
  if (Object.hasOwn(target, "fullPage")) {
    targetConfig.fullPage = target.fullPage;
  }
  if (target.captureMode) {
    targetConfig.captureMode = target.captureMode;
  }
  return targetConfig;
}

async function captureRelatedShotsForTarget(target, normalizedUrl, baseOutputPath, captureConfig) {
  if (target.id !== "shokz-home" || target.captureMode) {
    return { shots: [], validation: null };
  }

  let relatedCapture;
  try {
    relatedCapture = await capturePage(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: "shokz-home-related",
      fullPage: false,
      lazyLoadScroll: false
    });
  } catch (error) {
    await removeSidecarOutputs(baseOutputPath);
    return {
      shots: [],
      validation: {
        status: "warning",
        warnings: [{
          sectionKey: "home-related",
          sectionLabel: "更多截图",
          message: error.message
        }],
        sections: []
      }
    };
  }

  const relatedShots = [];

  for (const item of relatedCapture.captures || []) {
    const bannerIndex = Number(item.bannerIndex || 0);
    if ((item.sectionKey === "banner" || item.kind === "banner") && (item.isDefaultState || bannerIndex === 1)) {
      if (item.outputPath) {
        await fs.rm(item.outputPath, { force: true });
      }
      continue;
    }

    const relativePath = archiveRelativePath(item.outputPath);
    const stat = await fs.stat(item.outputPath);
    relatedShots.push({
      label: relatedShotLabelForCaptureItem(item),
      file: relativePath,
      imageUrl: publicSnapshotUrl(relativePath),
      bytes: stat.size,
      width: item.width,
      height: item.height,
      kind: item.kind || "banner",
      sectionKey: item.sectionKey || "banner",
      sectionLabel: item.sectionLabel || "Banner",
      sectionTitle: item.sectionTitle || "Banner 轮播图",
      stateIndex: item.stateIndex || bannerIndex || null,
      stateCount: item.stateCount || item.bannerCount || null,
      stateLabel: item.stateLabel || item.label || (bannerIndex ? `轮播 ${bannerIndex}` : "轮播"),
      tabLabel: item.tabLabel || null,
      tabIndex: item.tabIndex || null,
      pageIndex: item.pageIndex || null,
      productCount: item.productCount || null,
      visibleProductCount: item.visibleProductCount || null,
      visibleProducts: item.visibleProducts || null,
      itemCount: item.itemCount || null,
      visibleItemCount: item.visibleItemCount || null,
      visibleItems: item.visibleItems || null,
      logicalSignature: item.logicalSignature || item.bannerSignature || null,
      visualHash: item.visualHash || null,
      visualAudit: item.visualAudit || null,
      clip: item.clip || item.bannerClip || null,
      isDefaultState: Boolean(item.isDefaultState),
      bannerIndex: item.bannerIndex,
      bannerCount: item.bannerCount,
      bannerSignature: item.bannerSignature || null,
      visualSignature: item.visualSignature || null,
      bannerClip: item.bannerClip || null,
      bannerState: item.bannerState || null,
      sectionState: item.sectionState || null,
      urlCheck: relatedCapture.urlCheck || null,
      requestedUrl: relatedCapture.requestedUrl || normalizedUrl,
      finalUrl: relatedCapture.finalUrl || normalizedUrl
    });
  }

  return {
    shots: relatedShots.sort(compareRelatedShots),
    validation: relatedCapture.relatedValidation || null
  };
}

function archiveRelativePath(absolutePath) {
  return path.relative(archiveDir, absolutePath).replaceAll(path.sep, "/");
}

export function relatedShotLabelForCaptureItem(item) {
  const stateLabel = String(item?.stateLabel || "").trim();
  if (stateLabel && !/undefined|null/i.test(stateLabel)) {
    return stateLabel;
  }

  const label = String(item?.label || "").trim();
  if (label && !/undefined|null/i.test(label)) {
    return label;
  }

  const bannerIndex = Number(item?.bannerIndex || 0);
  return bannerIndex ? `轮播 ${bannerIndex}` : "轮播";
}

function bannerDisplayLabel(label, bannerIndex) {
  if (/Banner\s*[)\uff09]\s*$/.test(label)) {
    return label.replace(/Banner\s*([)\uff09])\s*$/, `Banner ${bannerIndex}$1`);
  }
  if (/[)\uff09]\s*$/.test(label)) {
    return label.replace(/([)\uff09])\s*$/, ` Banner ${bannerIndex}$1`);
  }
  return `${label} Banner ${bannerIndex}`;
}

function compareRelatedShots(a, b) {
  const sectionOrder = ["banner", "product-showcase", "scene-explore", "athletes", "media", "voices"];
  const sectionA = sectionOrder.indexOf(a.sectionKey);
  const sectionB = sectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB ||
    Number(a.tabIndex || 0) - Number(b.tabIndex || 0) ||
    Number(a.pageIndex || 0) - Number(b.pageIndex || 0) ||
    Number(a.stateIndex || a.bannerIndex || 0) - Number(b.stateIndex || b.bannerIndex || 0) ||
    String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
}

async function removeCaptureOutputs(basePath) {
  await fs.rm(basePath, { force: true });
  await removeSidecarOutputs(basePath);
}

async function removeSidecarOutputs(basePath) {
  const dir = path.dirname(basePath);
  const stem = path.basename(basePath, ".png");
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const bannerPath = basePath.replace(/\.png$/i, `-banner-${index + 1}.png`);
    return fs.rm(bannerPath, { force: true });
  }));
  await Promise.all(entries
    .filter((name) => name.startsWith(`${stem}-`) && name.endsWith(".png"))
    .map((name) => fs.rm(path.join(dir, name), { force: true })));
}

export async function browserStatus() {
  try {
    return { ok: true, path: await findBrowser() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
