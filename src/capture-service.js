import fs from "node:fs/promises";
import path from "node:path";
import { capturePage, findBrowser } from "./browser.js";
import { assessRelatedShotConfidence, assessSnapshotConfidence } from "./capture-confidence.js";
import { createCaptureDiagnosticRun, finalizeCaptureDiagnostic, recordCaptureDiagnostic } from "./capture-diagnostics.js";
import { rebuildChanges } from "./changes.js";
import { findDevicePreset, toPublicDevicePreset } from "./device-presets.js";
import { archiveDir } from "./paths.js";
import { shokzHomeRelatedSectionDefinitions, shokzRelatedSectionOrder } from "./shokz-capture-specs.js";
import {
  appendSnapshot,
  createSnapshotFilePath,
  findConfigDeviceProfile,
  loadConfig,
  normalizeCaptureTarget,
  normalizeConfig,
  normalizeDeviceProfile,
  publicSnapshotUrl,
  resolveConfiguredCapturePlans
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

function relatedCaptureModeForTarget(target, captureConfig) {
  if ((target.id === "shokz-products-nav" || captureConfig.captureMode === "shokz-products-nav") && captureConfig.platform !== "mobile") {
    return "shokz-products-nav-related";
  }

  return null;
}

async function captureRelatedShotsForTarget(target, normalizedUrl, baseOutputPath, captureConfig, diagnosticRun = null) {
  if (target.id === "shokz-home" && !captureConfig.captureMode) {
    return captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
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
      productCount: item.productCount || null,
      visibleProductCount: item.visibleProductCount || null,
      visibleProducts: item.visibleProducts || null,
      itemCount: item.itemCount || null,
      visibleItemCount: item.visibleItemCount || null,
      visibleItems: item.visibleItems || null,
      itemRects: item.itemRects || null,
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
      productCount: item.productCount || null,
      visibleProductCount: item.visibleProductCount || null,
      visibleProducts: item.visibleProducts || null,
      itemCount: item.itemCount || null,
      visibleItemCount: item.visibleItemCount || null,
      visibleItems: item.visibleItems || null,
      itemRects: item.itemRects || null,
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

  return relatedShots.sort(compareRelatedShots);
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
