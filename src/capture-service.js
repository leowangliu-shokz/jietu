import fs from "node:fs/promises";
import { capturePage, findBrowser } from "./browser.js";
import { devicePresets, findDevicePreset, toPublicDevicePreset } from "./device-presets.js";
import {
  appendSnapshot,
  createSnapshotFilePath,
  loadConfig,
  normalizeConfig,
  normalizeUrl,
  publicSnapshotUrl
} from "./store.js";

export async function captureConfiguredUrls(config = null, options = {}) {
  const activeConfig = config || await loadConfig();
  const results = [];
  for (const url of activeConfig.urls) {
    results.push(await captureOne(url, activeConfig, options));
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
    for (const url of presetConfig.urls) {
      results.push(await captureOne(url, presetConfig, options));
    }
  }
  return results;
}

export async function captureOne(inputUrl, config = null, options = {}) {
  const activeConfig = config || await loadConfig();
  const normalizedUrl = normalizeUrl(inputUrl);
  const capturedAt = new Date();
  const fileInfo = await createSnapshotFilePath(normalizedUrl, capturedAt);
  const devicePreset = findDevicePreset(activeConfig.devicePresetId);
  const publicDevice = devicePreset ? toPublicDevicePreset(devicePreset) : null;
  const runSource = options.runSource === "auto" ? "auto" : "manual";

  try {
    const capture = await capturePage(normalizedUrl, fileInfo.absolutePath, activeConfig);
    const stat = await fs.stat(fileInfo.absolutePath);
    const stamp = capturedAt.toISOString().replace(/[:.]/g, "-");
    const snapshot = await appendSnapshot({
      id: `${stamp}-${fileInfo.siteSlug}-${publicDevice?.id || "device"}-${runSource}`,
      url: normalizedUrl,
      requestedUrl: capture.requestedUrl || normalizedUrl,
      finalUrl: capture.finalUrl || normalizedUrl,
      urlCheck: capture.urlCheck || null,
      title: capture.title,
      capturedAt: capturedAt.toISOString(),
      file: fileInfo.relativePath,
      imageUrl: publicSnapshotUrl(fileInfo.relativePath),
      bytes: stat.size,
      width: capture.width,
      height: capture.height,
      devicePresetId: publicDevice?.id || activeConfig.devicePresetId || null,
      deviceName: publicDevice?.name || null,
      deviceLabel: publicDevice?.label || null,
      runSource,
      runLabel: runSource === "auto" ? "自动跑（整点）" : "手动跑",
      fullPageHeight: capture.fullPageHeight,
      truncated: capture.truncated,
      scrollInfo: capture.scrollInfo,
      browserPath: capture.browserPath
    });
    return { ok: true, snapshot };
  } catch (error) {
    await fs.rm(fileInfo.absolutePath, { force: true });
    return {
      ok: false,
      url: normalizedUrl,
      requestedUrl: error.requestedUrl || normalizedUrl,
      finalUrl: error.finalUrl || null,
      urlCheck: error.urlCheck || null,
      capturedAt: capturedAt.toISOString(),
      error: error.message
    };
  }
}

export async function browserStatus() {
  try {
    return { ok: true, path: await findBrowser() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
