import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultDevicePresetId,
  devicePresets,
  findDevicePreset,
  findDevicePresetByViewport,
  getDefaultDevicePreset
} from "./device-presets.js";
import { archiveDir, configPath, dataDir, snapshotsPath } from "./paths.js";

export const configSchemaVersion = 2;

const defaultTargetInputs = [
  {
    id: "shokz-home",
    url: "https://shokz.com/",
    label: "https://shokz.com/\uff08\u9996\u9875\uff09"
  },
  {
    id: "shokz-products-nav",
    url: "https://shokz.com/",
    label: "https://shokz.com/\uff08\u5bfc\u822a\u680f\uff09",
    captureMode: "shokz-products-nav",
    fullPage: false
  }
];

const defaultConfigScalars = {
  intervalMinutes: 0,
  fullPage: true,
  waitAfterLoadMs: 2500,
  dismissPopups: true,
  lazyLoadScroll: true,
  scrollStepMs: 350,
  hideFixedElementsAfterFirstSegment: true,
  maxFullPageHeight: 16000
};

const defaultConfig = createDefaultConfig();

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
  return readSnapshots();
}

export async function readSnapshots(filePath = snapshotsPath) {
  await ensureStorage();
  const snapshots = await readJson(filePath, []);
  return Array.isArray(snapshots)
    ? snapshots.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    : [];
}

export async function appendSnapshot(snapshot) {
  const snapshots = await readSnapshots();
  snapshots.unshift(snapshot);
  await saveSnapshots(snapshots);
  return snapshot;
}

export async function saveSnapshots(snapshots, filePath = snapshotsPath) {
  await writeJson(filePath, Array.isArray(snapshots) ? snapshots : []);
  return snapshots;
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
  const targets = normalizeCaptureTargets(
    Array.isArray(input.targets) ? input.targets : input.urls
  );
  const deviceProfiles = normalizeDeviceProfiles(input.deviceProfiles, input);
  const capturePlans = normalizeCapturePlans(input.capturePlans, targets, deviceProfiles);

  return {
    version: configSchemaVersion,
    targets: targets.length ? targets : defaultConfig.targets,
    deviceProfiles: deviceProfiles.length ? deviceProfiles : defaultConfig.deviceProfiles,
    capturePlans: capturePlans.length ? capturePlans : buildDefaultCapturePlans(
      targets.length ? targets : defaultConfig.targets,
      deviceProfiles.length ? deviceProfiles : defaultConfig.deviceProfiles
    ),
    intervalMinutes: clampNumber(input.intervalMinutes, 0, 10080, defaultConfigScalars.intervalMinutes),
    fullPage: Boolean(input.fullPage ?? defaultConfigScalars.fullPage),
    waitAfterLoadMs: clampNumber(input.waitAfterLoadMs, 0, 30000, defaultConfigScalars.waitAfterLoadMs),
    dismissPopups: Boolean(input.dismissPopups ?? defaultConfigScalars.dismissPopups),
    lazyLoadScroll: Boolean(input.lazyLoadScroll ?? defaultConfigScalars.lazyLoadScroll),
    scrollStepMs: clampNumber(input.scrollStepMs, 50, 3000, defaultConfigScalars.scrollStepMs),
    hideFixedElementsAfterFirstSegment: Boolean(
      input.hideFixedElementsAfterFirstSegment ?? defaultConfigScalars.hideFixedElementsAfterFirstSegment
    ),
    maxFullPageHeight: clampNumber(input.maxFullPageHeight, 1000, 60000, defaultConfigScalars.maxFullPageHeight)
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

export function normalizeDeviceProfile(input, index = 0, fallbackPlatform = null) {
  if (!input || typeof input !== "object") {
    throw new Error("Device profile is empty.");
  }

  const requestedPreset = findDevicePreset(String(input.devicePresetId || "").trim());
  const platform = normalizedPlatform(input.platform) ||
    (requestedPreset?.mobile ? "mobile" : "pc") ||
    fallbackPlatform ||
    "pc";
  const devicePreset = requestedPreset || defaultPresetForPlatform(platform);
  const id = stringOrDefault(input.id, `${platform}-profile-${index + 1}`);

  return {
    id,
    platform,
    devicePresetId: devicePreset.id,
    enabled: !Object.hasOwn(input, "enabled") || Boolean(input.enabled)
  };
}

export function normalizeCapturePlan(input, index = 0, targets = [], deviceProfiles = []) {
  if (!input || typeof input !== "object") {
    throw new Error("Capture plan is empty.");
  }

  const targetIds = new Set(targets.map((target) => target.id));
  const deviceProfileIds = new Set(deviceProfiles.map((profile) => profile.id));
  const targetId = stringOrDefault(input.targetId, "");
  const deviceProfileId = stringOrDefault(input.deviceProfileId, "");

  if (!targetIds.has(targetId)) {
    throw new Error(`Unknown capture plan target: ${targetId || "(missing)"}.`);
  }
  if (!deviceProfileIds.has(deviceProfileId)) {
    throw new Error(`Unknown capture plan device profile: ${deviceProfileId || "(missing)"}.`);
  }

  const plan = {
    id: stringOrDefault(input.id, `plan-${targetId}-${deviceProfileId}`),
    targetId,
    deviceProfileId,
    enabled: !Object.hasOwn(input, "enabled") || Boolean(input.enabled)
  };

  if (Object.hasOwn(input, "captureMode")) {
    const captureMode = stringOrDefault(input.captureMode, "");
    if (captureMode) {
      plan.captureMode = captureMode;
    }
  }
  if (Object.hasOwn(input, "fullPage")) {
    plan.fullPage = Boolean(input.fullPage);
  }

  return plan;
}

export function configTargets(config = {}) {
  return Array.isArray(config.targets) ? config.targets : [];
}

export function configDeviceProfiles(config = {}) {
  return Array.isArray(config.deviceProfiles) ? config.deviceProfiles : [];
}

export function configCapturePlans(config = {}) {
  return Array.isArray(config.capturePlans) ? config.capturePlans : [];
}

export function findConfigTarget(config, targetId) {
  return configTargets(config).find((target) => target.id === targetId) || null;
}

export function findConfigDeviceProfile(config, deviceProfileId) {
  return configDeviceProfiles(config).find((profile) => profile.id === deviceProfileId) || null;
}

export function findConfigCapturePlan(config, planId) {
  return configCapturePlans(config).find((plan) => plan.id === planId) || null;
}

export function resolveConfiguredCapturePlans(config, filters = {}) {
  const normalized = normalizeConfig(config);
  const targetsById = new Map(configTargets(normalized).map((target) => [target.id, target]));
  const deviceProfilesById = new Map(configDeviceProfiles(normalized).map((profile) => [profile.id, profile]));
  const requestedPlanIds = new Set(
    Array.isArray(filters.planIds)
      ? filters.planIds.map((planId) => String(planId || "").trim()).filter(Boolean)
      : []
  );
  const requestedPlatform = normalizedPlatform(filters.platform);
  const requestedTargetId = String(filters.targetId || "").trim();
  const requestedDeviceProfileId = String(filters.deviceProfileId || "").trim();
  const requestedDevicePresetId = String(filters.devicePresetId || "").trim();

  return configCapturePlans(normalized)
    .filter((plan) => plan.enabled !== false)
    .filter((plan) => requestedPlanIds.size === 0 || requestedPlanIds.has(plan.id))
    .filter((plan) => !requestedTargetId || plan.targetId === requestedTargetId)
    .filter((plan) => !requestedDeviceProfileId || plan.deviceProfileId === requestedDeviceProfileId)
    .map((plan) => {
      const target = targetsById.get(plan.targetId) || null;
      const deviceProfile = deviceProfilesById.get(plan.deviceProfileId) || null;
      const devicePreset = findDevicePreset(deviceProfile?.devicePresetId || "") || null;
      const platform = normalizedPlatform(deviceProfile?.platform) ||
        (devicePreset?.mobile ? "mobile" : "pc") ||
        "pc";
      return {
        ...plan,
        target,
        deviceProfile,
        devicePreset,
        platform
      };
    })
    .filter((plan) => plan.target && plan.deviceProfile && plan.devicePreset)
    .filter((plan) => !requestedPlatform || plan.platform === requestedPlatform)
    .filter((plan) => !requestedDevicePresetId || plan.devicePreset.id === requestedDevicePresetId);
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

function normalizeCaptureTargets(inputTargets) {
  const targets = Array.isArray(inputTargets) ? inputTargets : defaultTargetInputs;
  const seen = new Set();
  const normalized = [];

  for (const [index, input] of targets.entries()) {
    try {
      const target = normalizeCaptureTarget(input, index);
      const key = target.id || `${target.url}-${target.label}-${target.captureMode || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(target);
      }
    } catch {
      // Skip invalid targets and keep the rest of the user's configuration.
    }
  }

  return normalized;
}

function normalizeDeviceProfiles(inputProfiles, legacyInput = {}) {
  if (!Array.isArray(inputProfiles) || inputProfiles.length === 0) {
    return buildLegacyDeviceProfiles(legacyInput);
  }

  const seen = new Set();
  const normalized = [];
  for (const [index, input] of inputProfiles.entries()) {
    try {
      const profile = normalizeDeviceProfile(input, index);
      if (!seen.has(profile.id)) {
        seen.add(profile.id);
        normalized.push(profile);
      }
    } catch {
      // Skip invalid device profiles and keep the rest of the user's configuration.
    }
  }

  return normalized;
}

function normalizeCapturePlans(inputPlans, targets, deviceProfiles) {
  if (!Array.isArray(inputPlans) || inputPlans.length === 0) {
    return buildDefaultCapturePlans(targets, deviceProfiles);
  }

  const seen = new Set();
  const normalized = [];
  for (const [index, input] of inputPlans.entries()) {
    try {
      const plan = normalizeCapturePlan(input, index, targets, deviceProfiles);
      const key = `${plan.targetId}::${plan.deviceProfileId}`;
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(plan);
      }
    } catch {
      // Skip invalid plans and keep the rest of the user's configuration.
    }
  }

  return normalized;
}

function buildDefaultCapturePlans(targets, deviceProfiles) {
  const normalizedTargets = targets.length ? targets : normalizeCaptureTargets(defaultTargetInputs);
  const normalizedProfiles = deviceProfiles.length ? deviceProfiles : buildLegacyDeviceProfiles({});
  const plans = [];

  for (const target of normalizedTargets) {
    for (const profile of normalizedProfiles) {
      plans.push({
        id: `plan-${target.id}-${profile.id}`,
        targetId: target.id,
        deviceProfileId: profile.id,
        enabled: profile.enabled !== false
      });
    }
  }

  return plans;
}

function buildLegacyDeviceProfiles(input = {}) {
  const requestedPreset = findDevicePreset(String(input.devicePresetId || "").trim()) ||
    findDevicePresetByViewport(input.viewport) ||
    getDefaultDevicePreset();
  const primaryPlatform = requestedPreset.mobile ? "mobile" : "pc";
  const primaryProfileId = primaryPlatform === "mobile" ? "mobile-default" : "pc-default";
  const secondaryPlatform = primaryPlatform === "mobile" ? "pc" : "mobile";
  const secondaryProfileId = secondaryPlatform === "mobile" ? "mobile-default" : "pc-default";
  const secondaryPreset = defaultPresetForPlatform(secondaryPlatform);

  const profiles = [
    normalizeDeviceProfile({
      id: primaryProfileId,
      platform: primaryPlatform,
      devicePresetId: requestedPreset.id,
      enabled: true
    }, 0)
  ];

  if (secondaryPreset && secondaryPreset.id !== requestedPreset.id) {
    profiles.push(normalizeDeviceProfile({
      id: secondaryProfileId,
      platform: secondaryPlatform,
      devicePresetId: secondaryPreset.id,
      enabled: true
    }, 1));
  }

  return profiles;
}

function createDefaultConfig() {
  const targets = normalizeCaptureTargets(defaultTargetInputs);
  const deviceProfiles = buildLegacyDeviceProfiles({});
  return {
    version: configSchemaVersion,
    targets,
    deviceProfiles,
    capturePlans: buildDefaultCapturePlans(targets, deviceProfiles),
    ...defaultConfigScalars
  };
}

function defaultPresetForPlatform(platform) {
  if (platform === "mobile") {
    return findDevicePreset("iphone-15") ||
      devicePresets.find((preset) => preset.mobile) ||
      getDefaultDevicePreset();
  }

  return findDevicePreset(defaultDevicePresetId) ||
    devicePresets.find((preset) => !preset.mobile) ||
    getDefaultDevicePreset();
}

function normalizedPlatform(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "mobile" || key === "pc" ? key : null;
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
