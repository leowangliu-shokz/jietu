import { findDevicePreset } from "./device-presets.js";

export function platformForDevicePresetId(devicePresetId) {
  const preset = findDevicePreset(devicePresetId);
  if (!preset) {
    return null;
  }
  return preset.mobile ? "mobile" : "pc";
}

export function platformForSnapshot(snapshot = {}) {
  const explicit = normalizedPlatform(snapshot.platform);
  if (explicit) {
    return explicit;
  }

  const byPreset = platformForDevicePresetId(snapshot.devicePresetId);
  if (byPreset) {
    return byPreset;
  }

  const width = Number(snapshot.width || 0);
  const viewportHeight = Number(snapshot.scrollInfo?.viewportHeight || snapshot.height || 0);
  return width > 0 && width <= 820 && (!viewportHeight || viewportHeight <= 1180)
    ? "mobile"
    : "pc";
}

export function platformForChangeLocation(location = {}) {
  const explicit = normalizedPlatform(location.platform);
  if (explicit) {
    return explicit;
  }

  const byPreset = platformForDevicePresetId(location.devicePresetId);
  return byPreset || null;
}

export function annotateSnapshotRuntimeMetadata(snapshot, config = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  const platform = platformForSnapshot(snapshot);
  const deviceProfileId = matchingDeviceProfileId(config, {
    platform,
    deviceProfileId: snapshot.deviceProfileId,
    devicePresetId: snapshot.devicePresetId
  });
  const capturePlanId = matchingCapturePlanId(config, {
    capturePlanId: snapshot.capturePlanId,
    targetId: snapshot.targetId,
    platform,
    deviceProfileId,
    devicePresetId: snapshot.devicePresetId
  });

  let changed = false;
  const nextSnapshot = { ...snapshot };

  if (platform && nextSnapshot.platform !== platform) {
    nextSnapshot.platform = platform;
    changed = true;
  }
  if (deviceProfileId && nextSnapshot.deviceProfileId !== deviceProfileId) {
    nextSnapshot.deviceProfileId = deviceProfileId;
    changed = true;
  }
  if (capturePlanId && nextSnapshot.capturePlanId !== capturePlanId) {
    nextSnapshot.capturePlanId = capturePlanId;
    changed = true;
  }

  return changed ? nextSnapshot : snapshot;
}

export function annotateChangeRuntimeMetadata(change, config = null) {
  if (!change || typeof change !== "object") {
    return change;
  }

  const location = change.location && typeof change.location === "object"
    ? change.location
    : {};
  const platform = platformForChangeLocation(location) ||
    normalizedPlatform(change.to?.platform) ||
    normalizedPlatform(change.from?.platform) ||
    platformForSnapshot(change.to || change.from || {});
  const devicePresetId = location.devicePresetId || null;
  const deviceProfileId = matchingDeviceProfileId(config, {
    platform,
    deviceProfileId: location.deviceProfileId || change.to?.deviceProfileId || change.from?.deviceProfileId,
    devicePresetId
  });
  const capturePlanId = matchingCapturePlanId(config, {
    capturePlanId: location.capturePlanId || change.to?.capturePlanId || change.from?.capturePlanId,
    targetId: location.targetId,
    platform,
    deviceProfileId,
    devicePresetId
  });

  let changed = false;
  const nextChange = { ...change };
  const nextLocation = { ...location };

  if (platform && nextLocation.platform !== platform) {
    nextLocation.platform = platform;
    changed = true;
  }
  if (deviceProfileId && nextLocation.deviceProfileId !== deviceProfileId) {
    nextLocation.deviceProfileId = deviceProfileId;
    changed = true;
  }
  if (capturePlanId && nextLocation.capturePlanId !== capturePlanId) {
    nextLocation.capturePlanId = capturePlanId;
    changed = true;
  }

  if (changed) {
    nextChange.location = nextLocation;
  }

  if (change.to && typeof change.to === "object" && platform && change.to.platform !== platform) {
    nextChange.to = { ...change.to, platform };
    if (deviceProfileId && nextChange.to.deviceProfileId !== deviceProfileId) {
      nextChange.to.deviceProfileId = deviceProfileId;
    }
    if (capturePlanId && nextChange.to.capturePlanId !== capturePlanId) {
      nextChange.to.capturePlanId = capturePlanId;
    }
    changed = true;
  } else if (change.to && typeof change.to === "object") {
    const nextTo = { ...change.to };
    let toChanged = false;
    if (platform && nextTo.platform !== platform) {
      nextTo.platform = platform;
      toChanged = true;
    }
    if (deviceProfileId && nextTo.deviceProfileId !== deviceProfileId) {
      nextTo.deviceProfileId = deviceProfileId;
      toChanged = true;
    }
    if (capturePlanId && nextTo.capturePlanId !== capturePlanId) {
      nextTo.capturePlanId = capturePlanId;
      toChanged = true;
    }
    if (toChanged) {
      nextChange.to = nextTo;
      changed = true;
    }
  }

  if (change.from && typeof change.from === "object") {
    const nextFrom = { ...change.from };
    let fromChanged = false;
    if (platform && nextFrom.platform !== platform) {
      nextFrom.platform = platform;
      fromChanged = true;
    }
    if (deviceProfileId && nextFrom.deviceProfileId !== deviceProfileId) {
      nextFrom.deviceProfileId = deviceProfileId;
      fromChanged = true;
    }
    if (capturePlanId && nextFrom.capturePlanId !== capturePlanId) {
      nextFrom.capturePlanId = capturePlanId;
      fromChanged = true;
    }
    if (fromChanged) {
      nextChange.from = nextFrom;
      changed = true;
    }
  }

  return changed ? nextChange : change;
}

export function matchingDeviceProfileId(config, { platform = null, deviceProfileId = null, devicePresetId = null } = {}) {
  const profiles = Array.isArray(config?.deviceProfiles) ? config.deviceProfiles : [];
  const explicit = String(deviceProfileId || "").trim();
  if (explicit && (profiles.length === 0 || profiles.some((profile) => profile?.id === explicit))) {
    return explicit;
  }

  const matches = profiles.filter((profile) => {
    if (!profile || typeof profile !== "object") {
      return false;
    }
    if (profile.enabled === false) {
      return false;
    }
    if (devicePresetId && profile.devicePresetId !== devicePresetId) {
      return false;
    }
    const profilePlatform = normalizedPlatform(profile.platform) ||
      platformForDevicePresetId(profile.devicePresetId) ||
      "pc";
    if (platform && profilePlatform !== platform) {
      return false;
    }
    return true;
  });

  return matches[0]?.id || null;
}

export function matchingCapturePlanId(
  config,
  { capturePlanId = null, targetId = null, platform = null, deviceProfileId = null, devicePresetId = null } = {}
) {
  const plans = Array.isArray(config?.capturePlans) ? config.capturePlans : [];
  const explicit = String(capturePlanId || "").trim();
  if (explicit && (plans.length === 0 || plans.some((plan) => plan?.id === explicit))) {
    return explicit;
  }

  const resolvedDeviceProfileId = matchingDeviceProfileId(config, {
    platform,
    deviceProfileId,
    devicePresetId
  });

  const matches = plans.filter((plan) => {
    if (!plan || typeof plan !== "object") {
      return false;
    }
    if (plan.enabled === false) {
      return false;
    }
    if (targetId && plan.targetId !== targetId) {
      return false;
    }
    if (resolvedDeviceProfileId && plan.deviceProfileId !== resolvedDeviceProfileId) {
      return false;
    }
    return true;
  });

  return matches[0]?.id || null;
}

function normalizedPlatform(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "mobile" || key === "pc" ? key : null;
}
