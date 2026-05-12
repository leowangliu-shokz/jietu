import { findDevicePreset, findDevicePresetByViewport, toPublicDevicePreset } from "./device-presets.js";
import { shokzHomeRelatedSectionDefinitions } from "./shokz-capture-specs.js";

const defaultTargetLabelsById = {
  "shokz-home": "https://shokz.com/（首页）",
  "shokz-products-nav": "https://shokz.com/（导航栏）"
};

const defaultSectionMetadataByKey = {
  banner: {
    sectionLabel: "Banner",
    sectionTitle: "Banner 轮播图"
  },
  navigation: {
    sectionLabel: "Navigation",
    sectionTitle: "导航栏分级截图"
  }
};

for (const definition of shokzHomeRelatedSectionDefinitions) {
  defaultSectionMetadataByKey[definition.key] = {
    sectionLabel: definition.sectionLabel,
    sectionTitle: definition.title
  };
}

export function repairSnapshotsRuntimeMetadata(snapshots, options = {}) {
  const targetsById = targetLabelsById(options.targets);
  const sectionMetadataByKey = {
    ...defaultSectionMetadataByKey,
    ...(options.sectionMetadataByKey || {})
  };
  const stats = createRepairStats();

  const repairedSnapshots = (Array.isArray(snapshots) ? snapshots : []).map((snapshot) =>
    repairSnapshotRuntimeMetadata(snapshot, { targetsById, sectionMetadataByKey, stats })
  );

  stats.snapshotCountTouched = repairedSnapshots.filter((snapshot, index) => snapshot !== snapshots[index]).length;
  return {
    snapshots: repairedSnapshots,
    stats
  };
}

export function targetLabelsById(targets = []) {
  const labels = { ...defaultTargetLabelsById };
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target || typeof target !== "object") {
      continue;
    }
    const targetId = String(target.id || "").trim();
    const label = String(target.label || target.url || "").trim();
    if (targetId && label) {
      labels[targetId] = label;
    }
  }
  return labels;
}

export function sectionMetadataForKey(sectionKey, options = {}) {
  const key = String(sectionKey || "").trim();
  if (!key) {
    return null;
  }
  const sectionMetadataByKey = {
    ...defaultSectionMetadataByKey,
    ...(options.sectionMetadataByKey || {})
  };
  return sectionMetadataByKey[key] || null;
}

function repairSnapshotRuntimeMetadata(snapshot, context) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  let changed = false;
  const nextSnapshot = { ...snapshot };
  const targetLabel = context.targetsById[String(snapshot.targetId || "").trim()] || null;
  if (targetLabel && nextSnapshot.targetLabel !== targetLabel) {
    nextSnapshot.targetLabel = targetLabel;
    context.stats.targetLabelsRepaired += 1;
    changed = true;
  }
  if (targetLabel && nextSnapshot.displayUrl !== targetLabel) {
    nextSnapshot.displayUrl = targetLabel;
    context.stats.displayUrlsRepaired += 1;
    changed = true;
  }

  const deviceLabel = deviceLabelForSnapshot(snapshot);
  if (deviceLabel && nextSnapshot.deviceLabel !== deviceLabel) {
    nextSnapshot.deviceLabel = deviceLabel;
    context.stats.deviceLabelsRepaired += 1;
    changed = true;
  }

  if (Array.isArray(snapshot.relatedShots)) {
    const repairedRelatedShots = snapshot.relatedShots.map((shot) =>
      repairRelatedShotRuntimeMetadata(shot, context)
    );
    if (repairedRelatedShots.some((shot, index) => shot !== snapshot.relatedShots[index])) {
      nextSnapshot.relatedShots = repairedRelatedShots;
      changed = true;
    }
  }

  if (snapshot.relatedValidation && typeof snapshot.relatedValidation === "object") {
    const repairedValidation = repairRelatedValidation(snapshot.relatedValidation, context);
    if (repairedValidation !== snapshot.relatedValidation) {
      nextSnapshot.relatedValidation = repairedValidation;
      changed = true;
    }
  }

  return changed ? nextSnapshot : snapshot;
}

function repairRelatedShotRuntimeMetadata(shot, context) {
  if (!shot || typeof shot !== "object") {
    return shot;
  }

  const metadata = sectionMetadataForKey(shot.sectionKey, context);
  if (!metadata) {
    return shot;
  }

  let changed = false;
  const nextShot = { ...shot };

  if (nextShot.sectionLabel !== metadata.sectionLabel) {
    nextShot.sectionLabel = metadata.sectionLabel;
    context.stats.sectionLabelsRepaired += 1;
    changed = true;
  }
  if (nextShot.sectionTitle !== metadata.sectionTitle) {
    nextShot.sectionTitle = metadata.sectionTitle;
    context.stats.sectionTitlesRepaired += 1;
    changed = true;
  }

  return changed ? nextShot : shot;
}

function repairRelatedValidation(validation, context) {
  let changed = false;
  const nextValidation = { ...validation };

  if (Array.isArray(validation.sections)) {
    const repairedSections = validation.sections.map((section) => {
      if (!section || typeof section !== "object") {
        return section;
      }
      const metadata = sectionMetadataForKey(section.sectionKey, context);
      if (!metadata || section.sectionLabel === metadata.sectionLabel) {
        return section;
      }
      context.stats.validationSectionLabelsRepaired += 1;
      return {
        ...section,
        sectionLabel: metadata.sectionLabel
      };
    });
    if (repairedSections.some((section, index) => section !== validation.sections[index])) {
      nextValidation.sections = repairedSections;
      changed = true;
    }
  }

  if (Array.isArray(validation.warnings)) {
    const repairedWarnings = validation.warnings.map((warning) => {
      if (!warning || typeof warning !== "object") {
        return warning;
      }
      const metadata = sectionMetadataForKey(warning.sectionKey, context);
      if (!metadata || warning.sectionLabel === metadata.sectionLabel) {
        return warning;
      }
      context.stats.warningSectionLabelsRepaired += 1;
      return {
        ...warning,
        sectionLabel: metadata.sectionLabel
      };
    });
    if (repairedWarnings.some((warning, index) => warning !== validation.warnings[index])) {
      nextValidation.warnings = repairedWarnings;
      changed = true;
    }
  }

  return changed ? nextValidation : validation;
}

function deviceLabelForSnapshot(snapshot) {
  const preset = findDevicePreset(snapshot?.devicePresetId) ||
    findDevicePresetByViewport({
      width: Number(snapshot?.width || 0),
      height: Number(snapshot?.scrollInfo?.viewportHeight || snapshot?.height || 0)
    });
  if (!preset) {
    return null;
  }
  return toPublicDevicePreset(preset).label;
}

function createRepairStats() {
  return {
    snapshotCountTouched: 0,
    targetLabelsRepaired: 0,
    displayUrlsRepaired: 0,
    deviceLabelsRepaired: 0,
    sectionLabelsRepaired: 0,
    sectionTitlesRepaired: 0,
    validationSectionLabelsRepaired: 0,
    warningSectionLabelsRepaired: 0
  };
}
