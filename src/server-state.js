import { buildPlatformViews } from "../public/app-model.js";
import { devicePresets, toPublicDevicePreset } from "./device-presets.js";
import { annotateChangeRuntimeMetadata, annotateSnapshotRuntimeMetadata } from "./platform-metadata.js";

export function annotateSnapshotsForResponse(snapshots, config) {
  return (Array.isArray(snapshots) ? snapshots : [])
    .map((snapshot) => annotateSnapshotRuntimeMetadata(snapshot, config));
}

export function annotateChangesForResponse(changes, config) {
  return (Array.isArray(changes) ? changes : [])
    .map((change) => annotateChangeRuntimeMetadata(change, config));
}

export function buildStatePayload({
  config,
  captureState,
  nextRunAt,
  browser,
  snapshots,
  changes,
  captureIssues,
  permissions
}) {
  const publicDevicePresets = devicePresets.map(toPublicDevicePreset);
  const publicSnapshots = annotateSnapshotsForResponse(snapshots, config);
  const publicChanges = annotateChangesForResponse(changes, config);

  return {
    config,
    capture: captureState,
    nextRunAt,
    browser,
    devicePresets: publicDevicePresets,
    snapshots: publicSnapshots,
    captureIssues: Array.isArray(captureIssues) ? captureIssues : [],
    permissions,
    platforms: buildPlatformViews({
      config,
      snapshots: publicSnapshots,
      changes: publicChanges,
      devicePresets: publicDevicePresets
    }),
    changesSummary: {
      count: publicChanges.length,
      recent: publicChanges.slice(0, 6)
    }
  };
}
