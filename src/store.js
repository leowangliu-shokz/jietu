import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultDevicePresetId,
  findDevicePreset,
  findDevicePresetByViewport,
  getDefaultDevicePreset
} from "./device-presets.js";
import { archiveDir, configPath, dataDir, snapshotsPath } from "./paths.js";

const defaultConfig = {
  urls: [
    {
      id: "shokz-home",
      url: "https://shokz.com/",
      label: "https://shokz.com/\uff08\u9996\u9875\uff09"
    },
    {
      id: "shokz-home-banners",
      url: "https://shokz.com/",
      label: "https://shokz.com/\uff08\u9996\u9875 Banner\uff09",
      captureMode: "shokz-home-banners",
      fullPage: false
    },
    {
      id: "shokz-products-nav",
      url: "https://shokz.com/",
      label: "https://shokz.com/\uff08\u5bfc\u822a\u680f\uff09",
      captureMode: "shokz-products-nav",
      fullPage: false
    }
  ],
  intervalMinutes: 0,
  devicePresetId: defaultDevicePresetId,
  viewport: { width: 1920, height: 1080 },
  fullPage: true,
  waitAfterLoadMs: 2500,
  dismissPopups: true,
  lazyLoadScroll: true,
  scrollStepMs: 350,
  hideFixedElementsAfterFirstSegment: true,
  maxFullPageHeight: 16000
};

export async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(archiveDir, { recursive: true });
  await ensureJson(configPath, defaultConfig);
  await ensureJson(snapshotsPath, []);
}

export async function loadConfig() {
  await ensureStorage();
  const parsed = await readJson(configPath, defaultConfig);
  return normalizeConfig(parsed);
}

export async function saveConfig(nextConfig) {
  await ensureStorage();
  const config = normalizeConfig(nextConfig);
  await writeJson(configPath, config);
  return config;
}

export async function loadSnapshots() {
  await ensureStorage();
  const snapshots = await readJson(snapshotsPath, []);
  return Array.isArray(snapshots)
    ? snapshots.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    : [];
}

export async function appendSnapshot(snapshot) {
  const snapshots = await loadSnapshots();
  snapshots.unshift(snapshot);
  await writeJson(snapshotsPath, snapshots);
  return snapshot;
}

export async function createSnapshotFilePath(url, capturedAt = new Date()) {
  const normalized = normalizeUrl(url);
  const hostname = new URL(normalized).hostname.replace(/^www\./, "");
  const siteSlug = slugify(hostname);
  const day = capturedAt.toISOString().slice(0, 10);
  const stamp = capturedAt.toISOString().replace(/[:.]/g, "-");
  const folder = path.join(archiveDir, day, siteSlug);
  await fs.mkdir(folder, { recursive: true });
  return {
    absolutePath: path.join(folder, `${stamp}.png`),
    relativePath: path.relative(archiveDir, path.join(folder, `${stamp}.png`)).replaceAll(path.sep, "/"),
    siteSlug
  };
}

export function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("URL is empty.");
  }
  const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

export function normalizeConfig(input = {}) {
  const cleanUrls = normalizeCaptureTargets(input.urls);

  const requestedPreset = findDevicePreset(input.devicePresetId);
  const migratedPreset = requestedPreset || findDevicePresetByViewport(input.viewport);
  const devicePreset = migratedPreset || getDefaultDevicePreset();

  return {
    urls: cleanUrls.length ? cleanUrls : defaultConfig.urls,
    intervalMinutes: clampNumber(input.intervalMinutes, 0, 10080, defaultConfig.intervalMinutes),
    devicePresetId: devicePreset.id,
    viewport: {
      width: devicePreset.width,
      height: devicePreset.height,
      mobile: devicePreset.mobile,
      touch: devicePreset.touch,
      deviceScaleFactor: devicePreset.deviceScaleFactor
    },
    fullPage: Boolean(input.fullPage ?? defaultConfig.fullPage),
    waitAfterLoadMs: clampNumber(input.waitAfterLoadMs, 0, 30000, defaultConfig.waitAfterLoadMs),
    dismissPopups: Boolean(input.dismissPopups ?? defaultConfig.dismissPopups),
    lazyLoadScroll: Boolean(input.lazyLoadScroll ?? defaultConfig.lazyLoadScroll),
    scrollStepMs: clampNumber(input.scrollStepMs, 50, 3000, defaultConfig.scrollStepMs),
    hideFixedElementsAfterFirstSegment: Boolean(
      input.hideFixedElementsAfterFirstSegment ?? defaultConfig.hideFixedElementsAfterFirstSegment
    ),
    maxFullPageHeight: clampNumber(input.maxFullPageHeight, 1000, 60000, defaultConfig.maxFullPageHeight)
  };
}

export function normalizeCaptureTarget(input, index = 0) {
  if (typeof input === "string") {
    const url = normalizeUrl(input);
    return {
      id: `url-${index + 1}`,
      url,
      label: url
    };
  }

  if (!input || typeof input !== "object") {
    throw new Error("Capture target is empty.");
  }

  const url = normalizeUrl(input.url);
  const label = stringOrDefault(input.label, url);
  const id = stringOrDefault(input.id, `target-${index + 1}`);
  const captureMode = stringOrDefault(input.captureMode, "");
  const target = { id, url, label };

  if (captureMode) {
    target.captureMode = captureMode;
  }
  if (Object.hasOwn(input, "fullPage")) {
    target.fullPage = Boolean(input.fullPage);
  }

  return target;
}

export function publicSnapshotUrl(relativePath) {
  return `/archive/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function ensureJson(filePath, value) {
  try {
    await fs.access(filePath);
  } catch {
    await writeJson(filePath, value);
  }
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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeCaptureTargets(inputUrls) {
  const urls = Array.isArray(inputUrls) ? inputUrls : defaultConfig.urls;
  const seen = new Set();
  const targets = [];

  for (const [index, input] of urls.entries()) {
    try {
      const target = normalizeCaptureTarget(input, index);
      const key = target.id || `${target.url}-${target.label}-${target.captureMode || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    } catch {
      // Skip invalid targets and keep the rest of the user's configuration.
    }
  }

  return targets;
}

function stringOrDefault(value, fallback) {
  const string = String(value || "").trim();
  return string || fallback;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "site";
}
