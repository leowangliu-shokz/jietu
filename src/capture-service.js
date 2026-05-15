import fs from "node:fs/promises";
import path from "node:path";
import {
  capturePage,
  composeShokzHomeModuleCompositeCaptureFromFiles,
  composeShokzHomeOverviewCompositeCapture,
  findBrowser
} from "./browser.js";
import { assessRelatedShotConfidence, assessSnapshotConfidence } from "./capture-confidence.js";
import { createCaptureDiagnosticRun, finalizeCaptureDiagnostic, recordCaptureDiagnostic } from "./capture-diagnostics.js";
import { rebuildChanges } from "./changes.js";
import { findDevicePreset, toPublicDevicePreset } from "./device-presets.js";
import { archiveDir } from "./paths.js";
import {
  shokzCollectionRelatedSectionDefinitions,
  shokzComparisonRelatedSectionDefinitions,
  shokzHomeRelatedSectionDefinitions,
  shokzRelatedSectionOrder
} from "./shokz-capture-specs.js";
import {
  appendSnapshot,
  createSnapshotFilePath,
  findConfigDeviceProfile,
  loadConfig,
  loadSnapshots,
  normalizeCaptureTarget,
  normalizeConfig,
  normalizeDeviceProfile,
  publicSnapshotUrl,
  resolveConfiguredCapturePlans,
  saveSnapshots
} from "./store.js";

export async function captureConfiguredUrls(config = null, options = {}) {
  const activeConfig = normalizeConfig(config || await loadConfig());
  const plans = resolveConfiguredCapturePlans(activeConfig, options);
  return runResolvedCapturePlans(plans, activeConfig);
}

export async function captureAllDevices(config = null, options = {}) {
  return captureConfiguredUrls(config, options);
}

export async function captureOne(inputTarget, config = null, options = {}) {
  const activeConfig = normalizeConfig(config || await loadConfig());
  const execution = resolveAdHocCaptureExecution(inputTarget, activeConfig, options);
  return runCaptureExecution(execution, activeConfig);
}

export async function replaceHomeOverviewTile(input, config = null) {
  const snapshotId = stringOrNull(input?.snapshotId);
  const tileKey = stringOrNull(input?.tileKey);
  if (!snapshotId || !tileKey) {
    const error = new Error("snapshotId and tileKey are required");
    error.statusCode = 400;
    throw error;
  }

  const activeConfig = normalizeConfig(config || await loadConfig());
  const snapshots = await loadSnapshots();
  const snapshotIndex = snapshots.findIndex((entry) => entry?.id === snapshotId);
  if (snapshotIndex === -1) {
    const error = new Error("Snapshot not found");
    error.statusCode = 404;
    throw error;
  }

  const snapshot = snapshots[snapshotIndex];
  const tile = findHomeOverviewTile(snapshot, tileKey);
  if (!tile) {
    const error = new Error("Overview tile not found");
    error.statusCode = 404;
    throw error;
  }
  if (!tile.sourceFile || !tile.sectionKey) {
    const error = new Error("Selected tile cannot be replaced individually");
    error.statusCode = 400;
    throw error;
  }

  const moduleShot = findModuleShotForOverviewTile(snapshot, tile);
  if (!moduleShot?.composite?.variants?.length) {
    const error = new Error("Module composite for selected tile was not found");
    error.statusCode = 404;
    throw error;
  }

  const mainOutputPath = archiveAbsolutePath(snapshot.file);
  const sourceOutputPath = archiveAbsolutePath(tile.sourceFile);
  const captureConfig = buildTileReplacementCaptureConfig(snapshot, activeConfig);
  const captureMode = tile.sectionKey === "banner"
    ? "shokz-home-banners"
    : "shokz-home-related-section";
  const relatedCapture = await capturePage(snapshot.url || snapshot.requestedUrl || snapshot.finalUrl, mainOutputPath, {
    ...captureConfig,
    captureMode,
    sectionKey: tile.sectionKey === "banner" ? null : tile.sectionKey,
    fullPage: false,
    lazyLoadScroll: false,
    relatedStateFilter: {
      tileKey,
      tileLabel: tile.label,
      sectionKey: tile.sectionKey,
      sourceFile: tile.sourceFile
    },
    relatedStateOutputPath: sourceOutputPath,
    skipRelatedComposite: true
  });

  const replacementCapture = Array.isArray(relatedCapture?.captures)
    ? relatedCapture.captures[0]
    : null;
  if (!replacementCapture?.outputPath) {
    const error = new Error("Replacement capture did not produce an image");
    error.statusCode = 500;
    throw error;
  }

  const stateCaptures = stateCapturesForModuleReplacement({
    moduleShot,
    tile,
    replacementCapture,
    sourceOutputPath
  });
  const moduleComposite = await composeShokzHomeModuleCompositeCaptureFromFiles({
    mainOutputPath,
    stateCaptures,
    definition: {
      key: moduleShot.sectionKey,
      sectionLabel: moduleShot.sectionLabel || tile.sectionLabel || moduleShot.sectionKey,
      title: moduleShot.sectionTitle || moduleShot.sectionLabel || tile.sectionLabel || moduleShot.sectionKey
    },
    viewport: captureConfig.viewport || {}
  });
  const [updatedModuleShot] = await relatedShotsFromCaptureResult(
    {
      ...relatedCapture,
      captures: moduleComposite?.captures || [],
      requestedUrl: snapshot.requestedUrl || snapshot.url,
      finalUrl: snapshot.finalUrl || snapshot.url,
      urlCheck: moduleShot.urlCheck || snapshot.urlCheck || relatedCapture.urlCheck || null
    },
    snapshot.url,
    snapshot.relatedValidation || null
  );
  if (!updatedModuleShot) {
    const error = new Error("Replacement module composite could not be rebuilt");
    error.statusCode = 500;
    throw error;
  }

  const nextRelatedShots = (snapshot.relatedShots || [])
    .map((shot) => shot === moduleShot ? mergeRelatedShotForReplacement(moduleShot, updatedModuleShot) : shot)
    .sort(compareRelatedShots);
  const overview = await composeHomeOverviewForRelatedShots(mainOutputPath, nextRelatedShots, captureConfig);
  if (!overview.homeOverview) {
    const error = new Error("Home overview composite could not be rebuilt");
    error.statusCode = 500;
    throw error;
  }

  const updatedSnapshot = {
    ...snapshot,
    relatedShots: nextRelatedShots,
    homeOverview: overview.homeOverview,
    relatedValidation: relatedValidationWithWarnings(snapshot.relatedValidation, overview.warnings)
  };
  snapshots[snapshotIndex] = updatedSnapshot;
  await saveSnapshots(snapshots);
  const changeRefresh = await refreshChangeRecords();

  return {
    ok: true,
    snapshot: updatedSnapshot,
    tile,
    sourceFile: tile.sourceFile,
    relatedShot: updatedModuleShot,
    homeOverview: overview.homeOverview,
    changeRefresh
  };
}

async function runResolvedCapturePlans(plans, config) {
  const results = [];
  for (const execution of plans) {
    results.push(await runCaptureExecution(execution, config));
  }
  return results;
}

async function runCaptureExecution(execution, config) {
  const runner = execution.platform === "mobile"
    ? captureMobilePlan
    : capturePcPlan;
  return runner(execution, config);
}

async function capturePcPlan(execution, config) {
  return capturePlanExecution({ ...execution, platform: "pc" }, config);
}

async function captureMobilePlan(execution, config) {
  return capturePlanExecution({ ...execution, platform: "mobile" }, config);
}

async function capturePlanExecution(execution, config) {
  const target = execution.target;
  const normalizedUrl = target.url;
  const capturedAt = new Date();
  const fileInfo = await createSnapshotFilePath(normalizedUrl, capturedAt);
  const devicePreset = execution.devicePreset || findDevicePreset(execution.deviceProfile?.devicePresetId || "");
  const publicDevice = devicePreset ? toPublicDevicePreset(devicePreset) : null;
  const captureConfig = captureConfigForExecution(config, execution);
  const diagnosticRun = createCaptureDiagnosticRun({
    targetId: target.id,
    targetLabel: target.label || normalizedUrl,
    requestedUrl: normalizedUrl,
    captureMode: captureConfig.captureMode || null,
    devicePresetId: publicDevice?.id || execution.deviceProfile?.devicePresetId || null,
    platform: execution.platform,
    deviceProfileId: execution.deviceProfile?.id || null,
    capturePlanId: execution.id || null
  });

  try {
    const capture = await capturePage(normalizedUrl, fileInfo.absolutePath, captureConfig);
    recordCaptureDiagnostic(diagnosticRun, {
      type: "main-capture",
      ok: true,
      finalUrl: capture.finalUrl || normalizedUrl,
      width: capture.width || null,
      height: capture.height || null,
      visualAudit: capture.visualAudit || null,
      urlCheck: capture.urlCheck || null,
      captureValidation: capture.captureValidation || null
    });
    const relatedCapture = await captureRelatedShotsForTarget(
      target,
      normalizedUrl,
      fileInfo.absolutePath,
      captureConfig,
      diagnosticRun
    );
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
      const visualAudit = item.visualAudit || capture.visualAudit || null;
      const captureConfidence = assessSnapshotConfidence({
        visualAudit,
        urlCheck: capture.urlCheck || null
      });
      const snapshot = await appendSnapshot({
        id: `${stamp}-${fileInfo.siteSlug}-${itemTargetId}-${execution.id || publicDevice?.id || "device"}`,
        url: normalizedUrl,
        targetId: itemTargetId,
        targetLabel: itemTargetLabel,
        displayUrl,
        captureMode: captureConfig.captureMode || null,
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
        devicePresetId: publicDevice?.id || execution.deviceProfile?.devicePresetId || null,
        deviceName: publicDevice?.name || null,
        deviceLabel: publicDevice?.label || null,
        platform: execution.platform,
        deviceProfileId: execution.deviceProfile?.id || null,
        capturePlanId: execution.id || null,
        fullPageHeight: capture.fullPageHeight,
        truncated: capture.truncated,
        scrollInfo: capture.scrollInfo,
        browserPath: capture.browserPath,
        bannerIndex: item.bannerIndex || null,
        bannerCount: item.bannerCount || null,
        bannerSignature: item.bannerSignature || null,
        visualSignature: item.visualSignature || null,
        visualAudit,
        captureConfidence,
        bannerClip: item.bannerClip || null,
        bannerState: item.bannerState || null,
        bannerValidation: item.bannerIndex ? capture.bannerInfo || null : null,
        homeOverview: !item.bannerIndex ? relatedCapture.homeOverview || null : null,
        relatedValidation: !item.bannerIndex ? relatedCapture.validation : null,
        relatedShots: !item.bannerIndex && relatedShots.length ? relatedShots : null
      });
      snapshots.push(snapshot);
    }

    const changeRefresh = await refreshChangeRecords();
    recordCaptureDiagnostic(diagnosticRun, {
      type: "snapshot-write",
      ok: true,
      snapshotCount: snapshots.length,
      relatedShotCount: relatedShots.length,
      lowConfidenceSnapshots: snapshots
        .filter((snapshot) => snapshot.captureConfidence?.baselineEligible === false)
        .map((snapshot) => ({
          targetId: snapshot.targetId,
          reasons: snapshot.captureConfidence.reasons
        })),
      lowConfidenceRelatedShots: relatedShots
        .filter((shot) => shot.captureConfidence?.baselineEligible === false)
        .map((shot) => ({
          sectionKey: shot.sectionKey,
          stateLabel: shot.stateLabel || shot.label || null,
          reasons: shot.captureConfidence.reasons
        })),
      changeRefresh
    });
    await finalizeCaptureDiagnostic(diagnosticRun, {
      ok: true,
      targetId: target.id,
      requestedUrl: normalizedUrl,
      snapshotCount: snapshots.length,
      relatedShotCount: relatedShots.length,
      lowConfidenceSnapshotCount: snapshots.filter((snapshot) => snapshot.captureConfidence?.baselineEligible === false).length,
      lowConfidenceRelatedShotCount: relatedShots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length,
      warningCount: Array.isArray(relatedCapture.validation?.warnings) ? relatedCapture.validation.warnings.length : 0,
      changeRefresh
    });
    return {
      ok: true,
      platform: execution.platform,
      capturePlanId: execution.id || null,
      deviceProfileId: execution.deviceProfile?.id || null,
      snapshot: snapshots[0],
      snapshots,
      changeRefresh
    };
  } catch (error) {
    await removeCaptureOutputs(fileInfo.absolutePath);
    recordCaptureDiagnostic(diagnosticRun, {
      type: "capture-error",
      ok: false,
      error: error.message,
      requestedUrl: error.requestedUrl || normalizedUrl,
      finalUrl: error.finalUrl || null,
      urlCheck: error.urlCheck || null,
      captureValidation: error.captureValidation || null
    });
    await finalizeCaptureDiagnostic(diagnosticRun, {
      ok: false,
      targetId: target.id,
      requestedUrl: normalizedUrl,
      error: error.message
    });
    return {
        ok: false,
        url: normalizedUrl,
        targetId: target.id,
        targetLabel: target.label || normalizedUrl,
        displayUrl: target.label || normalizedUrl,
        captureMode: captureConfig.captureMode || null,
        platform: execution.platform,
        deviceProfileId: execution.deviceProfile?.id || null,
        capturePlanId: execution.id || null,
        requestedUrl: error.requestedUrl || normalizedUrl,
        finalUrl: error.finalUrl || null,
        urlCheck: error.urlCheck || null,
      capturedAt: capturedAt.toISOString(),
      error: error.message
    };
  }
}

function resolveAdHocCaptureExecution(inputTarget, config, options = {}) {
  const target = normalizeCaptureTarget(inputTarget);
  const selectedPlan = resolveConfiguredCapturePlans(config, {
    planIds: options.planIds,
    platform: options.platform,
    deviceProfileId: options.deviceProfileId,
    devicePresetId: options.devicePresetId
  })[0] || resolveConfiguredCapturePlans(config)[0];
  const deviceProfile = selectedPlan?.deviceProfile || resolveAdHocDeviceProfile(config, options);
  const devicePreset = selectedPlan?.devicePreset || findDevicePreset(deviceProfile?.devicePresetId || "");
  const platform = selectedPlan?.platform ||
    deviceProfile?.platform ||
    (devicePreset?.mobile ? "mobile" : "pc") ||
    "pc";

  return {
    id: selectedPlan?.target?.id === target.id
      ? selectedPlan.id
      : `adhoc-${selectedPlan?.id || deviceProfile?.id || platform}-${target.id}`,
    target,
    deviceProfile,
    devicePreset,
    platform,
    captureMode: stringOrNull(options.captureMode) || target.captureMode || selectedPlan?.captureMode || null,
    ...(Object.hasOwn(options, "fullPage")
      ? { fullPage: Boolean(options.fullPage) }
      : Object.hasOwn(target, "fullPage")
        ? { fullPage: Boolean(target.fullPage) }
        : Object.hasOwn(selectedPlan || {}, "fullPage")
          ? { fullPage: Boolean(selectedPlan.fullPage) }
          : {})
  };
}

function resolveAdHocDeviceProfile(config, options = {}) {
  const requestedProfileId = String(options.deviceProfileId || "").trim();
  if (requestedProfileId) {
    const configuredProfile = findConfigDeviceProfile(config, requestedProfileId);
    if (configuredProfile) {
      return configuredProfile;
    }
  }

  const requestedPresetId = String(options.devicePresetId || "").trim();
  if (requestedPresetId) {
    return normalizeDeviceProfile({
      id: `adhoc-${requestedPresetId}`,
      platform: options.platform || null,
      devicePresetId: requestedPresetId,
      enabled: true
    });
  }

  const fallbackPlan = resolveConfiguredCapturePlans(config, {
    platform: options.platform
  })[0] || resolveConfiguredCapturePlans(config)[0];
  if (fallbackPlan?.deviceProfile) {
    return fallbackPlan.deviceProfile;
  }

  return normalizeDeviceProfile({
    id: "adhoc-default",
    platform: options.platform || "pc",
    devicePresetId: options.platform === "mobile" ? "iphone-15" : "pc-hd",
    enabled: true
  });
}

async function refreshChangeRecords() {
  try {
    const changes = await rebuildChanges();
    return { ok: true, count: changes.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function captureConfigForExecution(config, execution) {
  const targetConfig = {
    ...config,
    platform: execution.platform,
    devicePresetId: execution.devicePreset?.id || execution.deviceProfile?.devicePresetId || null,
    viewport: {
      width: execution.devicePreset?.width || 1440,
      height: execution.devicePreset?.height || 1000,
      mobile: execution.platform === "mobile",
      touch: Boolean(execution.devicePreset?.touch),
      deviceScaleFactor: execution.devicePreset?.deviceScaleFactor || 1
    }
  };
  if (Object.hasOwn(execution.target, "fullPage")) {
    targetConfig.fullPage = execution.target.fullPage;
  }
  if (Object.hasOwn(execution, "fullPage")) {
    targetConfig.fullPage = execution.fullPage;
  }
  const captureMode = execution.captureMode || execution.target.captureMode || null;
  if (captureMode) {
    targetConfig.captureMode = captureMode;
  }
  return targetConfig;
}

function stringOrNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

function findHomeOverviewTile(snapshot, tileKey) {
  const variants = snapshot?.homeOverview?.composite?.variants;
  if (!Array.isArray(variants)) {
    return null;
  }
  return variants.find((variant) => variant?.key === tileKey) || null;
}

function findModuleShotForOverviewTile(snapshot, tile) {
  const relatedShots = Array.isArray(snapshot?.relatedShots) ? snapshot.relatedShots : [];
  return relatedShots.find((shot) =>
    shot?.kind === "collection-tab-composite" &&
    shot?.sectionKey === tile.sectionKey
  ) || null;
}

function buildTileReplacementCaptureConfig(snapshot, config) {
  const preset = findDevicePreset(snapshot.devicePresetId || "");
  const platform = snapshot.platform || (preset?.mobile ? "mobile" : "pc");
  const viewportWidth = Number(snapshot.scrollInfo?.viewportWidth || snapshot.width || preset?.width || 393);
  const viewportHeight = Number(snapshot.scrollInfo?.viewportHeight || preset?.height || 852);
  return {
    ...config,
    platform,
    devicePresetId: snapshot.devicePresetId || preset?.id || config?.devicePresetId || null,
    viewport: {
      width: Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 393,
      height: Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 852,
      mobile: platform === "mobile" || Boolean(preset?.mobile),
      touch: Boolean(preset?.touch || platform === "mobile"),
      deviceScaleFactor: preset?.deviceScaleFactor || 1
    }
  };
}

function stateCapturesForModuleReplacement({ moduleShot, tile, replacementCapture, sourceOutputPath }) {
  const replacementSourceFile = archiveRelativePath(sourceOutputPath);
  return (moduleShot.composite?.variants || []).map((variant, index) => {
    const outputPath = archiveAbsolutePath(variant.sourceFile);
    const isReplacement = variant.sourceFile === replacementSourceFile || variant.sourceFile === tile.sourceFile;
    if (isReplacement) {
      return stateCaptureFromVariant({
        moduleShot,
        variant,
        index,
        outputPath: sourceOutputPath,
        replacementCapture
      });
    }
    return stateCaptureFromVariant({
      moduleShot,
      variant,
      index,
      outputPath,
      replacementCapture: null
    });
  });
}

function stateCaptureFromVariant({ moduleShot, variant, index, outputPath, replacementCapture }) {
  const stateIndex = Number(variant.pageIndex || variant.stateIndex || variant.bannerIndex || index + 1);
  const base = {
    outputPath,
    width: Number(variant.sourceClip?.width || variant.rect?.width || 0) || null,
    height: Number(variant.sourceClip?.height || variant.rect?.height || 0) || null,
    kind: "carousel",
    sectionKey: moduleShot.sectionKey,
    sectionLabel: moduleShot.sectionLabel,
    sectionTitle: moduleShot.sectionTitle,
    stateIndex,
    stateCount: moduleShot.composite?.variantCount || moduleShot.itemCount || null,
    stateLabel: variant.label || `State ${index + 1}`,
    label: variant.label || `State ${index + 1}`,
    tabLabel: variant.tabLabel || null,
    tabIndex: variant.tabIndex || null,
    pageIndex: variant.pageIndex || stateIndex,
    bannerIndex: variant.bannerIndex || null,
    interactionState: variant.interactionState || "default",
    coverageKey: variant.key || null,
    logicalSignature: variant.key || variant.label || null,
    bannerSignature: null,
    clip: variant.sourceClip || null,
    bannerClip: variant.sourceClip || null,
    visibleItems: null,
    itemRects: null,
    sectionState: {
      text: variant.text || "",
      activeIndex: stateIndex,
      interactionState: variant.interactionState || "default"
    }
  };
  if (!replacementCapture) {
    return base;
  }
  return {
    ...base,
    ...replacementCapture,
    outputPath,
    stateIndex: replacementCapture.stateIndex || base.stateIndex,
    stateCount: replacementCapture.stateCount || base.stateCount,
    stateLabel: replacementCapture.stateLabel || base.stateLabel,
    label: replacementCapture.label || replacementCapture.stateLabel || base.label,
    pageIndex: replacementCapture.pageIndex || base.pageIndex,
    bannerIndex: replacementCapture.bannerIndex || base.bannerIndex,
    interactionState: replacementCapture.interactionState || base.interactionState,
    coverageKey: base.coverageKey || replacementCapture.coverageKey || null,
    logicalSignature: base.logicalSignature || replacementCapture.logicalSignature || null,
    clip: replacementCapture.clip || replacementCapture.bannerClip || base.clip,
    bannerClip: replacementCapture.bannerClip || replacementCapture.clip || base.bannerClip,
    sectionState: replacementCapture.sectionState || base.sectionState
  };
}

function mergeRelatedShotForReplacement(previousShot, updatedShot) {
  return {
    ...previousShot,
    ...updatedShot,
    captureConfidence: updatedShot.captureConfidence || previousShot.captureConfidence || null
  };
}

function relatedValidationWithWarnings(validation, warnings = []) {
  if (!Array.isArray(warnings) || !warnings.length) {
    return validation || null;
  }
  const next = validation && typeof validation === "object"
    ? { ...validation }
    : { status: "warning", warnings: [], sections: [] };
  next.status = "warning";
  next.warnings = [
    ...(Array.isArray(next.warnings) ? next.warnings : []),
    ...warnings
  ];
  if (!Array.isArray(next.sections)) {
    next.sections = [];
  }
  return next;
}

function relatedCaptureModeForTarget(target, captureConfig) {
  if (target.id === "shokz-products-nav" || captureConfig.captureMode === "shokz-products-nav") {
    return "shokz-products-nav-related";
  }
  if (captureConfig.captureMode === "shokz-collection-page") {
    return "shokz-collection-related-section";
  }
  if (captureConfig.captureMode === "shokz-comparison-page") {
    return "shokz-comparison-related-section";
  }

  return null;
}

async function captureRelatedShotsForTarget(target, normalizedUrl, baseOutputPath, captureConfig, diagnosticRun = null) {
  if (target.id === "shokz-home" && !captureConfig.captureMode) {
    return captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
  }
  if (captureConfig.captureMode === "shokz-collection-page") {
    return captureShokzCollectionRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
  }
  if (captureConfig.captureMode === "shokz-comparison-page") {
    return captureShokzComparisonRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
  }

  const relatedMode = relatedCaptureModeForTarget(target, captureConfig);
  if (!relatedMode) {
    return { shots: [], validation: null };
  }

  let relatedCapture;
  try {
    relatedCapture = await capturePage(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: relatedMode,
      fullPage: false,
      lazyLoadScroll: false
    });
  } catch (error) {
    await removeSidecarOutputs(baseOutputPath);
    recordCaptureDiagnostic(diagnosticRun, {
      type: "related-capture",
      ok: false,
      sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "related",
      sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation" : "More screenshots",
      captureMode: relatedMode,
      error: error.message,
      captureValidation: error.captureValidation || null
    });
    return {
      shots: [],
      validation: {
        status: "warning",
        warnings: [{
          sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "home-related",
          sectionLabel: "更多截图",
          message: error.message
        }],
        sections: []
      }
    };
  }

  const validation = validationForRelatedCaptureResult(relatedCapture, {
    sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "related",
    sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation" : "More screenshots"
  });
  const relatedShots = [];

  for (const item of relatedCapture.captures || []) {
    const bannerIndex = Number(item.bannerIndex || 0);
    const relativePath = archiveRelativePath(item.outputPath);
    const stat = await fs.stat(item.outputPath);
    const shot = {
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
      interactionState: item.interactionState || "default",
      navigationLevel: item.navigationLevel || null,
      topLevelLabel: item.topLevelLabel || null,
      topLevelIndex: item.topLevelIndex || null,
      hoverItemKey: item.hoverItemKey || null,
      hoverItemLabel: item.hoverItemLabel || null,
      hoverItemRect: item.hoverItemRect || null,
      basePageIndex: item.basePageIndex || null,
      hoverIndex: item.hoverIndex || null,
      trackLabel: item.trackLabel || item.tabLabel || null,
      trackIndex: item.trackIndex || item.tabIndex || null,
      categoryKey: item.categoryKey || null,
      categoryLabel: item.categoryLabel || null,
      productKey: item.productKey || null,
      productLabel: item.productLabel || null,
      productIndex: item.productIndex || null,
      variantKey: item.variantKey || null,
      variantLabel: item.variantLabel || null,
      variantOptions: Array.isArray(item.variantOptions) ? item.variantOptions : null,
      productCount: item.productCount || null,
      visibleProductCount: item.visibleProductCount || null,
      visibleProducts: item.visibleProducts || null,
      itemCount: item.itemCount || null,
      visibleItemCount: item.visibleItemCount || null,
      visibleItems: publicRelatedVisibleItems(item.visibleItems),
      itemRects: item.itemRects || null,
      composite: publicRelatedComposite(item.composite),
      windowSignature: item.windowSignature || null,
      logicalSignature: item.logicalSignature || item.bannerSignature || null,
      visualHash: item.visualHash || null,
      visualAudit: item.visualAudit || null,
      clip: item.clip || item.bannerClip || null,
      isDefaultState: Boolean(item.isDefaultState),
      coverageKey: item.coverageKey || null,
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
    };
    shot.captureConfidence = assessRelatedShotConfidence(shot, validation);
    relatedShots.push(shot);
  }

  recordCaptureDiagnostic(diagnosticRun, {
    type: "related-capture",
    ok: true,
    sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "related",
    sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation" : "More screenshots",
    captureMode: relatedMode,
    shotCount: relatedShots.length,
    warningCount: Array.isArray(validation?.warnings) ? validation.warnings.length : 0,
    lowConfidenceShotCount: relatedShots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length,
    captureValidation: summarizeCaptureValidationEntries(relatedCapture.captures || [])
  });
  return {
    shots: relatedShots.sort(compareRelatedShots),
    validation
  };
}

async function captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const descriptors = [
    {
      sectionKey: "banner",
      sectionLabel: "Banner",
      captureMode: "shokz-home-banners"
    },
    ...shokzHomeRelatedSectionDefinitions.map((definition) => ({
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      captureMode: "shokz-home-related-section",
      sectionCaptureKey: definition.key
    }))
  ];
  const shots = [];
  const warnings = [];
  const sections = [];

  for (const descriptor of descriptors) {
    const result = await captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun);
    shots.push(...result.shots);
    warnings.push(...(result.validation?.warnings || []));
    sections.push(...(result.validation?.sections || []));
  }

  sections.sort(compareRelatedSectionEntries);
  const sortedShots = shots.sort(compareRelatedShots);
  const overview = await composeHomeOverviewForRelatedShots(baseOutputPath, sortedShots, captureConfig);
  warnings.push(...overview.warnings);

  return {
    shots: sortedShots,
    homeOverview: overview.homeOverview,
    validation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function composeHomeOverviewForRelatedShots(baseOutputPath, relatedShots, captureConfig) {
  const compositeShots = relatedShots.filter((shot) => shot.kind === "collection-tab-composite" && shot.composite);
  if (!compositeShots.length) {
    return { homeOverview: null, warnings: [] };
  }

  const outputPath = baseOutputPath.replace(/\.png$/i, "-home-overview-map.png");
  try {
    const overview = await composeShokzHomeOverviewCompositeCapture({
      mainOutputPath: baseOutputPath,
      outputPath,
      viewport: captureConfig.viewport || {},
      relatedShots: compositeShots.map((shot) => ({
        ...shot,
        outputPath: path.join(archiveDir, shot.file)
      }))
    });
    const relativePath = archiveRelativePath(overview.outputPath);
    const stat = await fs.stat(overview.outputPath);
    return {
      homeOverview: {
        label: overview.label,
        file: relativePath,
        imageUrl: publicSnapshotUrl(relativePath),
        bytes: stat.size,
        width: overview.width,
        height: overview.height,
        kind: overview.kind,
        sectionKey: overview.sectionKey,
        sectionLabel: overview.sectionLabel,
        sectionTitle: overview.sectionTitle,
        stateIndex: overview.stateIndex,
        stateCount: overview.stateCount,
        stateLabel: overview.stateLabel,
        interactionState: overview.interactionState,
        logicalSignature: overview.logicalSignature,
        visualSignature: overview.visualSignature,
        visualHash: overview.visualHash,
        visualAudit: overview.visualAudit,
        clip: overview.clip,
        scrollInfo: overview.scrollInfo,
        composite: publicRelatedComposite(overview.composite),
        itemCount: overview.itemCount,
        visibleItemCount: overview.visibleItemCount,
        visibleItems: publicRelatedVisibleItems(overview.visibleItems),
        itemRects: overview.itemRects
      },
      warnings: []
    };
  } catch (error) {
    return {
      homeOverview: null,
      warnings: [{
        sectionKey: "home-overview",
        sectionLabel: "首页总览图",
        message: `Could not compose home overview screenshot: ${error.message}`
      }]
    };
  }
}

async function captureShokzCollectionRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const descriptors = shokzCollectionRelatedSectionDefinitions.map((definition) => ({
    sectionKey: definition.key,
    sectionLabel: definition.sectionLabel,
    captureMode: "shokz-collection-related-section",
    sectionCaptureKey: definition.key
  }));
  const shots = [];
  const warnings = [];
  const sections = [];

  for (const descriptor of descriptors) {
    const result = await captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun);
    shots.push(...result.shots);
    warnings.push(...(result.validation?.warnings || []));
    sections.push(...(result.validation?.sections || []));
  }

  sections.sort(compareRelatedSectionEntries);

  return {
    shots: shots.sort(compareRelatedShots),
    validation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function captureShokzComparisonRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const descriptors = shokzComparisonRelatedSectionDefinitions.map((definition) => ({
    sectionKey: definition.key,
    sectionLabel: definition.sectionLabel,
    captureMode: "shokz-comparison-related-section",
    sectionCaptureKey: definition.key
  }));
  const shots = [];
  const warnings = [];
  const sections = [];

  for (const descriptor of descriptors) {
    const result = await captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun);
    shots.push(...result.shots);
    warnings.push(...(result.validation?.warnings || []));
    sections.push(...(result.validation?.sections || []));
  }

  sections.sort(compareRelatedSectionEntries);

  return {
    shots: shots.sort(compareRelatedShots),
    validation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun) {
  let relatedCapture;
  try {
    relatedCapture = await capturePage(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: descriptor.captureMode,
      sectionKey: descriptor.sectionCaptureKey || null,
      fullPage: false,
      lazyLoadScroll: false
    });
  } catch (error) {
    recordCaptureDiagnostic(diagnosticRun, {
      type: "related-capture",
      ok: false,
      sectionKey: descriptor.sectionKey,
      sectionLabel: descriptor.sectionLabel,
      captureMode: descriptor.captureMode,
      error: error.message,
      captureValidation: error.captureValidation || null
    });
    return {
      shots: [],
      validation: {
        status: "warning",
        warnings: [{
          sectionKey: descriptor.sectionKey,
          sectionLabel: descriptor.sectionLabel,
          message: error.message
        }],
        sections: [{
          sectionKey: descriptor.sectionKey,
          sectionLabel: descriptor.sectionLabel,
          expectedCount: 0,
          capturedCount: 0,
          savedCount: 0,
          status: "warning"
        }]
      }
    };
  }

  const validation = validationForRelatedCaptureResult(relatedCapture, descriptor);
  const shots = [];
  for (const shot of await relatedShotsFromCaptureResult(relatedCapture, normalizedUrl, validation)) {
    shots.push(shot);
  }
  recordCaptureDiagnostic(diagnosticRun, {
    type: "related-capture",
    ok: true,
    sectionKey: descriptor.sectionKey,
    sectionLabel: descriptor.sectionLabel,
    captureMode: descriptor.captureMode,
    shotCount: shots.length,
    warningCount: Array.isArray(validation?.warnings) ? validation.warnings.length : 0,
    lowConfidenceShotCount: shots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length,
    captureValidation: summarizeCaptureValidationEntries(relatedCapture.captures || [])
  });
  return { shots, validation };
}

async function relatedShotsFromCaptureResult(relatedCapture, normalizedUrl, validation) {
  const relatedShots = [];

  for (const item of relatedCapture.captures || []) {
    const bannerIndex = Number(item.bannerIndex || 0);
    const relativePath = archiveRelativePath(item.outputPath);
    const stat = await fs.stat(item.outputPath);
    const shot = {
      label: relatedShotLabelForCaptureItem(item),
      file: relativePath,
      imageUrl: publicSnapshotUrl(relativePath),
      bytes: stat.size,
      width: item.width,
      height: item.height,
      kind: item.kind || "banner",
      sectionKey: item.sectionKey || "banner",
      sectionLabel: item.sectionLabel || "Banner",
      sectionTitle: item.sectionTitle || "Banner",
      stateIndex: item.stateIndex || bannerIndex || null,
      stateCount: item.stateCount || item.bannerCount || null,
      stateLabel: item.stateLabel || item.label || (bannerIndex ? `轮播 ${bannerIndex}` : "轮播"),
      tabLabel: item.tabLabel || null,
      tabIndex: item.tabIndex || null,
      pageIndex: item.pageIndex || null,
      interactionState: item.interactionState || "default",
      navigationLevel: item.navigationLevel || null,
      topLevelLabel: item.topLevelLabel || null,
      topLevelIndex: item.topLevelIndex || null,
      hoverItemKey: item.hoverItemKey || null,
      hoverItemLabel: item.hoverItemLabel || null,
      hoverItemRect: item.hoverItemRect || null,
      basePageIndex: item.basePageIndex || null,
      hoverIndex: item.hoverIndex || null,
      trackLabel: item.trackLabel || item.tabLabel || null,
      trackIndex: item.trackIndex || item.tabIndex || null,
      categoryKey: item.categoryKey || null,
      categoryLabel: item.categoryLabel || null,
      productKey: item.productKey || null,
      productLabel: item.productLabel || null,
      productIndex: item.productIndex || null,
      variantKey: item.variantKey || null,
      variantLabel: item.variantLabel || null,
      variantOptions: Array.isArray(item.variantOptions) ? item.variantOptions : null,
      productCount: item.productCount || null,
      visibleProductCount: item.visibleProductCount || null,
      visibleProducts: item.visibleProducts || null,
      itemCount: item.itemCount || null,
      visibleItemCount: item.visibleItemCount || null,
      visibleItems: publicRelatedVisibleItems(item.visibleItems),
      itemRects: item.itemRects || null,
      composite: publicRelatedComposite(item.composite),
      windowSignature: item.windowSignature || null,
      logicalSignature: item.logicalSignature || item.bannerSignature || null,
      visualHash: item.visualHash || null,
      visualAudit: item.visualAudit || null,
      clip: item.clip || item.bannerClip || null,
      scrollInfo: item.scrollInfo || null,
      isDefaultState: Boolean(item.isDefaultState),
      coverageKey: item.coverageKey || null,
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
    };
    shot.captureConfidence = assessRelatedShotConfidence(shot, validation);
    relatedShots.push(shot);
  }

  return relatedShots.sort(compareRelatedShots);
}

function publicRelatedComposite(composite) {
  if (!composite || typeof composite !== "object") {
    return null;
  }
  return {
    ...composite,
    variants: Array.isArray(composite.variants)
      ? composite.variants.map(publicRelatedVisibleItem).filter(Boolean)
      : composite.variants
  };
}

function publicRelatedVisibleItems(items) {
  return Array.isArray(items)
    ? items.map(publicRelatedVisibleItem).filter(Boolean)
    : null;
}

function publicRelatedVisibleItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const sourceOutputPath = stringOrNull(item.sourceOutputPath);
  const sourceFile = stringOrNull(item.sourceFile) ||
    (sourceOutputPath ? archiveRelativePath(sourceOutputPath) : null);
  const next = { ...item };
  delete next.sourceOutputPath;
  if (sourceFile) {
    next.sourceFile = sourceFile;
    next.sourceImageUrl = publicSnapshotUrl(sourceFile);
  }
  return next;
}

function validationForRelatedCaptureResult(relatedCapture, descriptor) {
  if (relatedCapture.relatedValidation) {
    return relatedCapture.relatedValidation;
  }
  const captures = Array.isArray(relatedCapture.captures) ? relatedCapture.captures : [];
  const savedCount = captures.length;
  const expectedCount = Number(relatedCapture.bannerInfo?.expectedCount || savedCount || 0);
  return {
    status: "ok",
    warnings: [],
    sections: [{
      sectionKey: descriptor.sectionKey,
      sectionLabel: descriptor.sectionLabel,
      expectedCount,
      capturedCount: savedCount,
      savedCount,
      status: "ok"
    }]
  };
}

function summarizeCaptureValidationEntries(items = []) {
  const validations = [];
  for (const item of items) {
    if (!item?.captureValidation) {
      continue;
    }
    validations.push({
      itemLabel: item.stateLabel || item.label || item.sectionKey || item.kind || null,
      sectionKey: item.sectionKey || null,
      kind: item.kind || null,
      ...item.captureValidation
    });
  }
  return validations.length ? validations : null;
}

function archiveRelativePath(absolutePath) {
  return path.relative(archiveDir, absolutePath).replaceAll(path.sep, "/");
}

function archiveAbsolutePath(relativePath) {
  const input = stringOrNull(relativePath);
  if (!input) {
    throw new Error("Archive file path is required");
  }
  const base = path.resolve(archiveDir);
  const absolutePath = path.resolve(base, input);
  const normalizedBase = base.toLowerCase();
  const normalizedPath = absolutePath.toLowerCase();
  if (normalizedPath !== normalizedBase && !normalizedPath.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error(`Archive file path is outside archive directory: ${input}`);
  }
  return absolutePath;
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
  const sectionA = shokzRelatedSectionOrder.indexOf(a.sectionKey);
  const sectionB = shokzRelatedSectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB ||
    Number(a.tabIndex || 0) - Number(b.tabIndex || 0) ||
    Number(a.productIndex || 0) - Number(b.productIndex || 0) ||
    interactionSort(a) - interactionSort(b) ||
    Number(a.pageIndex || 0) - Number(b.pageIndex || 0) ||
    Number(a.hoverIndex || 0) - Number(b.hoverIndex || 0) ||
    Number(a.stateIndex || a.bannerIndex || 0) - Number(b.stateIndex || b.bannerIndex || 0) ||
    String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
}

function compareRelatedSectionEntries(a, b) {
  const sectionA = shokzRelatedSectionOrder.indexOf(a.sectionKey);
  const sectionB = shokzRelatedSectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB || String(a.sectionLabel || "").localeCompare(String(b.sectionLabel || ""), "zh-CN");
}

function interactionSort(item) {
  return item?.interactionState === "hover" ? 1 : 0;
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

export const __testOnly = {
  captureConfigForExecution,
  relatedCaptureModeForTarget,
  resolveAdHocCaptureExecution,
  runnerNameForPlatform
};

function runnerNameForPlatform(platform) {
  return platform === "mobile" ? "captureMobilePlan" : "capturePcPlan";
}
