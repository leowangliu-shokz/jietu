import fs from "node:fs/promises";
import path from "node:path";
import { capturePage, findBrowser } from "./browser.js";
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

export async function captureConfiguredUrls(config = null, options = {}) {
  const activeConfig = config || await loadConfig();
  const results = [];
  for (const target of activeConfig.urls) {
    results.push(await captureOne(target, activeConfig, options));
  }
  return results;
}

export async function captureAllDevices(config = null, options = {}) {
  const activeConfig = config || await loadConfig();
  const results = [];
  for (const preset of devicePresets) {
    const presetConfig = normalizeConfig({
      ...activeConfig,
      devicePresetId: preset.id
    });
    for (const target of presetConfig.urls) {
      results.push(await captureOne(target, presetConfig, options));
    }
  }
  return results;
}

export async function captureOne(inputTarget, config = null, options = {}) {
  const activeConfig = config || await loadConfig();
  const target = normalizeCaptureTarget(inputTarget);
  const normalizedUrl = target.url;
  const capturedAt = new Date();
  const fileInfo = await createSnapshotFilePath(normalizedUrl, capturedAt);
  const devicePreset = findDevicePreset(activeConfig.devicePresetId);
  const publicDevice = devicePreset ? toPublicDevicePreset(devicePreset) : null;
  const runSource = options.runSource === "auto" ? "auto" : "manual";
  const captureConfig = captureConfigForTarget(activeConfig, target);

  try {
    const capture = await capturePage(normalizedUrl, fileInfo.absolutePath, captureConfig);
    const relatedShots = await captureRelatedShotsForTarget(target, normalizedUrl, fileInfo.absolutePath, captureConfig);
    const stamp = capturedAt.toISOString().replace(/[:.]/g, "-");
    const targetLabel = target.label || normalizedUrl;
    const runLabel = runSource === "auto" ? "\u81ea\u52a8\u8dd1\uff08\u6574\u70b9\uff09" : "\u624b\u52a8\u8dd1";
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
        id: `${stamp}-${fileInfo.siteSlug}-${itemTargetId}-${publicDevice?.id || "device"}-${runSource}`,
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
        runSource,
        runLabel,
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
        relatedShots: !item.bannerIndex && relatedShots.length ? relatedShots : null
      });
      snapshots.push(snapshot);
    }

    return { ok: true, snapshot: snapshots[0], snapshots };
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
    return [];
  }

  const bannerCapture = await capturePage(normalizedUrl, baseOutputPath, {
    ...captureConfig,
    captureMode: "shokz-home-banners",
    fullPage: false,
    lazyLoadScroll: false
  });
  const relatedShots = [];

  for (const item of bannerCapture.captures || []) {
    const bannerIndex = Number(item.bannerIndex || 0);
    if (bannerIndex === 1) {
      if (item.outputPath) {
        await fs.rm(item.outputPath, { force: true });
      }
      continue;
    }

    const relativePath = archiveRelativePath(item.outputPath);
    const stat = await fs.stat(item.outputPath);
    relatedShots.push({
      kind: "banner",
      label: `\u8f6e\u64ad ${item.bannerIndex}`,
      file: relativePath,
      imageUrl: publicSnapshotUrl(relativePath),
      bytes: stat.size,
      width: item.width,
      height: item.height,
      bannerIndex: item.bannerIndex,
      bannerCount: item.bannerCount,
      bannerSignature: item.bannerSignature || null,
      visualSignature: item.visualSignature || null,
      bannerClip: item.bannerClip || null,
      bannerState: item.bannerState || null,
      urlCheck: bannerCapture.urlCheck || null,
      requestedUrl: bannerCapture.requestedUrl || normalizedUrl,
      finalUrl: bannerCapture.finalUrl || normalizedUrl
    });
  }

  return relatedShots.sort((a, b) => Number(a.bannerIndex || 0) - Number(b.bannerIndex || 0));
}

function archiveRelativePath(absolutePath) {
  return path.relative(archiveDir, absolutePath).replaceAll(path.sep, "/");
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

async function removeCaptureOutputs(basePath) {
  await fs.rm(basePath, { force: true });
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const bannerPath = basePath.replace(/\.png$/i, `-banner-${index + 1}.png`);
    return fs.rm(bannerPath, { force: true });
  }));
}

export async function browserStatus() {
  try {
    return { ok: true, path: await findBrowser() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
