export const platformOrder = ["pc", "mobile"];

export function platformLabel(platform) {
  return platform === "mobile" ? "手机" : "PC";
}

export function configTargets(config = {}) {
  if (Array.isArray(config?.targets)) {
    return config.targets.filter(isTargetLike);
  }

  if (!Array.isArray(config?.urls)) {
    return [];
  }

  return config.urls
    .map((target, index) => legacyTargetToTarget(target, index))
    .filter(Boolean);
}

export function configDeviceProfiles(config = {}) {
  return Array.isArray(config?.deviceProfiles)
    ? config.deviceProfiles.filter(isDeviceProfileLike)
    : [];
}

export function configCapturePlans(config = {}) {
  return Array.isArray(config?.capturePlans)
    ? config.capturePlans.filter(isCapturePlanLike)
    : [];
}

export function platformForSnapshot(snapshot, devicePresets = []) {
  const explicit = normalizedPlatform(snapshot?.platform);
  if (explicit) {
    return explicit;
  }

  const byPreset = platformForPreset(devicePresets, snapshot?.devicePresetId);
  if (byPreset) {
    return byPreset;
  }

  return inferPlatformFromDimensions(
    Number(snapshot?.width || 0),
    Number(snapshot?.scrollInfo?.viewportHeight || snapshot?.height || 0)
  );
}

export function platformForChange(change, devicePresets = []) {
  const explicit = normalizedPlatform(change?.location?.platform);
  if (explicit) {
    return explicit;
  }

  const byPreset = platformForPreset(devicePresets, change?.location?.devicePresetId);
  if (byPreset) {
    return byPreset;
  }

  return platformForSnapshot(change?.to || change?.from || {}, devicePresets);
}

export function buildPlatformViews({ config, snapshots = [], changes = [], devicePresets = [] } = {}) {
  const views = {
    pc: createEmptyPlatformView("pc"),
    mobile: createEmptyPlatformView("mobile")
  };
  const targetsById = new Map(configTargets(config).map((target) => [target.id, target]));
  const deviceProfiles = configDeviceProfiles(config);
  const deviceProfilesById = new Map(deviceProfiles.map((profile) => [profile.id, profile]));

  for (const profile of deviceProfiles) {
    const platform = profilePlatform(profile, devicePresets);
    const view = views[platform] || views.pc;
    view.deviceProfileIds.push(profile.id);
    view.deviceProfiles.push(profile);
  }

  for (const plan of configCapturePlans(config)) {
    const profile = deviceProfilesById.get(plan.deviceProfileId);
    const target = targetsById.get(plan.targetId);
    const platform = profilePlatform(profile, devicePresets);
    const view = views[platform] || views.pc;
    view.capturePlanIds.push(plan.id);
    view.capturePlans.push(plan);
    if (target && !view.targetIds.includes(target.id)) {
      view.targetIds.push(target.id);
      view.targets.push(target);
    }
  }

  for (const snapshot of snapshots) {
    const platform = platformForSnapshot(snapshot, devicePresets);
    const view = views[platform] || views.pc;
    view.snapshotCount += 1;
  }

  for (const change of changes) {
    const platform = platformForChange(change, devicePresets);
    const view = views[platform] || views.pc;
    view.changeCount += 1;
  }

  return views;
}

function createEmptyPlatformView(platform) {
  return {
    id: platform,
    label: platformLabel(platform),
    snapshotCount: 0,
    changeCount: 0,
    targetIds: [],
    targets: [],
    deviceProfileIds: [],
    deviceProfiles: [],
    capturePlanIds: [],
    capturePlans: []
  };
}

function legacyTargetToTarget(target, index) {
  if (typeof target === "string") {
    const url = String(target).trim();
    if (!url) {
      return null;
    }
    return {
      id: `url-${index + 1}`,
      url,
      label: url
    };
  }

  return isTargetLike(target)
    ? target
    : null;
}

function isTargetLike(target) {
  return Boolean(target) &&
    typeof target === "object" &&
    String(target.id || "").trim() &&
    String(target.url || "").trim();
}

function isDeviceProfileLike(profile) {
  return Boolean(profile) &&
    typeof profile === "object" &&
    String(profile.id || "").trim() &&
    String(profile.devicePresetId || "").trim();
}

function isCapturePlanLike(plan) {
  return Boolean(plan) &&
    typeof plan === "object" &&
    String(plan.id || "").trim() &&
    String(plan.targetId || "").trim() &&
    String(plan.deviceProfileId || "").trim();
}

function normalizedPlatform(value) {
  const key = String(value || "").trim().toLowerCase();
  return platformOrder.includes(key) ? key : null;
}

function profilePlatform(profile, devicePresets = []) {
  const explicit = normalizedPlatform(profile?.platform);
  if (explicit) {
    return explicit;
  }

  const byPreset = platformForPreset(devicePresets, profile?.devicePresetId);
  return byPreset || "pc";
}

function platformForPreset(devicePresets, devicePresetId) {
  const preset = (Array.isArray(devicePresets) ? devicePresets : [])
    .find((candidate) => candidate?.id === devicePresetId);
  if (!preset) {
    return null;
  }
  return preset.mobile ? "mobile" : "pc";
}

function inferPlatformFromDimensions(width, viewportHeight) {
  return width > 0 && width <= 820 && (!viewportHeight || viewportHeight <= 1180)
    ? "mobile"
    : "pc";
}
