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
import { withCaptureLock } from "./capture-lock.js";
import { appendCaptureRun } from "./capture-runs.js";
import { loadChanges, rebuildChanges } from "./changes.js";
import { notifyChangeRecords } from "./change-notifier.js";
import { findDevicePreset, toPublicDevicePreset } from "./device-presets.js";
import { boundedConcurrency, runJobQueue } from "./job-queue.js";
import { archiveDir } from "./paths.js";
import { appendSeoSnapshots, createSeoSnapshotRecord, rebuildSeoChanges } from "./seo-snapshots.js";
import {
  shokzCollectionRelatedSectionDefinitions,
  shokzComparisonRelatedSectionDefinitions,
  shokzHomeRelatedSectionDefinitions,
  shokzRelatedSectionOrder
} from "./shokz-capture-specs.js";
import {
  appendSnapshots,
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
import { rebuildTextQuality } from "./text-quality.js";

const mobileCollectionRelatedSectionTimeoutMs = 25 * 60 * 1000;
const mobileComparisonProductMapTimeoutMs = 55 * 60 * 1000;

export async function captureConfiguredUrls(config = null, options = {}) {
  const activeConfig = normalizeConfig(config || await loadConfig());
  const plans = resolveConfiguredCapturePlans(activeConfig, options);
  return withCaptureLock(() => runResolvedCapturePlans(plans, activeConfig, options));
}

export async function captureAllDevices(config = null, options = {}) {
  return captureConfiguredUrls(config, options);
}

export async function captureOne(inputTarget, config = null, options = {}) {
  const activeConfig = normalizeConfig(config || await loadConfig());
  const execution = resolveAdHocCaptureExecution(inputTarget, activeConfig, options);
  return withCaptureLock(() => runCaptureExecution(execution, activeConfig, options));
}

export async function replaceCaptureTile(input, config = null) {
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
  const homeTile = findHomeOverviewTile(snapshot, tileKey) ||
    findHomeOverviewTileBySourceFile(snapshot, input?.sourceFile);
  if (homeTile && (replacementTargetsHomeOverview(snapshot, input) || snapshot.targetId === "shokz-home")) {
    return replaceHomeOverviewTile({ ...input, tileKey: homeTile.key }, activeConfig);
  }

  const relatedMatch = findRelatedShotForReplacement(snapshot, input);
  if (relatedMatch) {
    return replaceRelatedShotTile({
      input,
      snapshots,
      snapshotIndex,
      snapshot,
      relatedShot: relatedMatch.shot,
      activeConfig
    });
  }

  const previewFile = stringOrNull(input?.previewFile) || stringOrNull(input?.overviewFile);
  if (previewFile && !fileMatchesReplacement(snapshot.file, previewFile)) {
    const error = new Error("Related screenshot for replacement was not found");
    error.statusCode = 404;
    throw error;
  }

  return replaceSnapshotImage({
    input,
    snapshots,
    snapshotIndex,
    snapshot,
    activeConfig
  });
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
  const overview = await composePageOverviewForRelatedShots(mainOutputPath, nextRelatedShots, captureConfig, {
    sectionKey: snapshot.homeOverview?.sectionKey || "home-overview",
    sectionLabel: snapshot.homeOverview?.sectionLabel || "Home overview",
    sectionTitle: snapshot.homeOverview?.sectionTitle || "Home overview",
    stateLabel: snapshot.homeOverview?.stateLabel || "Home overview",
    label: snapshot.homeOverview?.label || "Home overview",
    outputSuffix: "-home-overview-map.png"
  });
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
  const changeRefresh = await refreshChangeRecords({ sendNotifications: false });
  const textQualityRefresh = await refreshTextQualityRecords();

  return {
    ok: true,
    snapshot: updatedSnapshot,
    tile,
    sourceFile: tile.sourceFile,
    relatedShot: updatedModuleShot,
    homeOverview: overview.homeOverview,
    changeRefresh,
    textQualityRefresh
  };
}

async function replaceRelatedShotTile({ input, snapshots, snapshotIndex, snapshot, relatedShot, activeConfig }) {
  const sourceFile = stringOrNull(input?.sourceFile) || relatedShot.file;
  if (!relatedShot?.file) {
    const error = new Error("Selected related screenshot cannot be replaced individually");
    error.statusCode = 400;
    throw error;
  }

  const mainOutputPath = archiveAbsolutePath(snapshot.file);
  const relatedOutputPath = archiveAbsolutePath(relatedShot.file);
  const captureConfig = buildTileReplacementCaptureConfig(snapshot, activeConfig);
  const captureMode = relatedReplacementCaptureMode(snapshot, relatedShot, input);
  const sectionKey = stringOrNull(input?.sectionKey) || relatedShot.sectionKey || null;
  const relatedCapture = await capturePage(snapshot.url || snapshot.requestedUrl || snapshot.finalUrl, mainOutputPath, {
    ...captureConfig,
    captureMode,
    sectionKey: sectionKey === "banner" || sectionKey === "navigation" ? null : sectionKey,
    fullPage: false,
    lazyLoadScroll: false,
    relatedStateFilter: replacementFilterForRelatedShot(input, relatedShot, sourceFile),
    relatedStateOutputPath: relatedOutputPath,
    skipRelatedComposite: false
  });

  const validation = validationForRelatedCaptureResult(relatedCapture, {
    sectionKey: relatedShot.sectionKey || sectionKey || "related",
    sectionLabel: relatedShot.sectionLabel || "More screenshots"
  });
  const replacementShots = await relatedShotsFromCaptureResult(
    {
      ...relatedCapture,
      requestedUrl: snapshot.requestedUrl || snapshot.url,
      finalUrl: snapshot.finalUrl || snapshot.url
    },
    snapshot.url,
    validation
  );
  const replacementShot = selectReplacementRelatedShot(replacementShots, relatedShot, input);
  if (!replacementShot) {
    const error = new Error("Replacement capture did not produce a matching related screenshot");
    error.statusCode = 500;
    throw error;
  }

  const nextRelatedShots = (snapshot.relatedShots || [])
    .map((shot) => shot === relatedShot ? mergeRelatedShotForReplacement(relatedShot, replacementShot) : shot)
    .sort(compareRelatedShots);
  const updatedSnapshot = {
    ...snapshot,
    relatedShots: nextRelatedShots,
    relatedValidation: relatedValidationWithWarnings(snapshot.relatedValidation, validation?.warnings || [])
  };
  snapshots[snapshotIndex] = updatedSnapshot;
  await saveSnapshots(snapshots);
  const changeRefresh = await refreshChangeRecords({ sendNotifications: false });
  const textQualityRefresh = await refreshTextQualityRecords();
  const preview = nextRelatedShots.find((shot) => shot.file === replacementShot.file) || replacementShot;

  return {
    ok: true,
    snapshot: updatedSnapshot,
    tile: input,
    sourceFile,
    relatedShot: preview,
    preview,
    changeRefresh,
    textQualityRefresh
  };
}

async function replaceSnapshotImage({ input, snapshots, snapshotIndex, snapshot, activeConfig }) {
  const outputPath = archiveAbsolutePath(snapshot.file);
  const captureConfig = buildTileReplacementCaptureConfig(snapshot, activeConfig);
  const captureMode = stringOrNull(snapshot.captureMode) || stringOrNull(input?.captureMode) || null;
  const capture = await capturePage(snapshot.url || snapshot.requestedUrl || snapshot.finalUrl, outputPath, {
    ...captureConfig,
    captureMode,
    fullPage: captureMode === "shokz-products-nav" ? false : Boolean(activeConfig.fullPage),
    lazyLoadScroll: captureMode === "shokz-products-nav" ? false : activeConfig.lazyLoadScroll !== false
  });
  const stat = await fs.stat(outputPath);
  const updatedSnapshot = {
    ...snapshot,
    requestedUrl: capture.requestedUrl || snapshot.requestedUrl,
    finalUrl: capture.finalUrl || snapshot.finalUrl,
    urlCheck: capture.urlCheck || snapshot.urlCheck || null,
    title: capture.title || snapshot.title,
    bytes: stat.size,
    width: capture.width || snapshot.width,
    height: capture.height || snapshot.height,
    fullPageHeight: capture.fullPageHeight,
    truncated: capture.truncated,
    scrollInfo: capture.scrollInfo || snapshot.scrollInfo || null,
    browserPath: capture.browserPath || snapshot.browserPath || null,
    visualHash: capture.visualHash || snapshot.visualHash || null,
    visualAudit: capture.visualAudit || snapshot.visualAudit || null
  };
  updatedSnapshot.captureConfidence = assessSnapshotConfidence({
    visualAudit: updatedSnapshot.visualAudit,
    urlCheck: updatedSnapshot.urlCheck
  });
  snapshots[snapshotIndex] = updatedSnapshot;
  await saveSnapshots(snapshots);
  const changeRefresh = await refreshChangeRecords({ sendNotifications: false });
  const textQualityRefresh = await refreshTextQualityRecords();

  return {
    ok: true,
    snapshot: updatedSnapshot,
    tile: input,
    sourceFile: snapshot.file,
    preview: updatedSnapshot,
    changeRefresh,
    textQualityRefresh
  };
}

async function runResolvedCapturePlans(plans, config, options = {}) {
  const run = createCaptureRunRecord(plans, options);
  const results = new Array(plans.length);
  const concurrency = captureConcurrency(config, options);
  run.concurrency = concurrency;
  let saveQueue = Promise.resolve();

  async function runPlan(execution, { index: planIndex }) {
    const item = run.items[planIndex];
    item.status = "running";
    item.startedAt = new Date().toISOString();
    const startedAt = Date.now();
    let result;
    try {
      result = await runCaptureExecution(execution, config, {
        ...options,
        captureBatchIndex: planIndex,
        deferSnapshotSave: true,
        deferChangeRefresh: true
      });
    } catch (error) {
      result = {
        ok: false,
        error: error?.message || String(error)
      };
    }
    result = failResultWithRetriableRelatedWarnings(result);
    if (result?.ok) {
      try {
        await enqueuePreparedCaptureSave(result);
      } catch (error) {
        result.ok = false;
        result.error = `Capture completed but failed to save snapshot index: ${error.message}`;
      }
    }
    item.finishedAt = new Date().toISOString();
    item.durationMs = Date.now() - startedAt;
    item.ok = Boolean(result?.ok);
    item.status = result?.ok ? "succeeded" : "failed";
    item.error = result?.ok ? null : result?.error || "Capture failed.";
    item.snapshotIds = captureResultSnapshots(result).map((snapshot) => snapshot.id).filter(Boolean);
    results[planIndex] = {
      ...result,
      runId: run.id,
      runItemId: item.id,
      runIndex: planIndex + 1,
      runTotal: plans.length
    };
    return results[planIndex];
  }

  function enqueuePreparedCaptureSave(result) {
    const saveTask = saveQueue.then(() => persistPreparedCaptureResult(result));
    saveQueue = saveTask.catch(() => null);
    return saveTask;
  }

  const queue = await runJobQueue(plans, runPlan, {
    concurrency,
    maxConcurrency: 8,
    throwOnError: false
  });
  await retryFailedCapturePlans({
    plans,
    config,
    options,
    run,
    results,
    savePreparedCaptureResult: enqueuePreparedCaptureSave
  });

  const changeRefresh = options.deferChangeRefresh
    ? { ok: true, deferred: true }
    : await refreshChangeRecords();
  const seoRefresh = options.deferChangeRefresh
    ? { ok: true, deferred: true }
    : await refreshSeoChangeRecords();
  const textQualityRefresh = options.deferChangeRefresh
    ? { ok: true, deferred: true }
    : await refreshTextQualityRecords();
  const finishedAt = new Date();
  run.finishedAt = finishedAt.toISOString();
  run.durationMs = finishedAt.getTime() - new Date(run.startedAt).getTime();
  run.successCount = results.filter((result) => result?.ok).length;
  run.failureCount = results.filter((result) => result && !result.ok).length;
  run.jobQueue = {
    totalCount: queue.totalCount,
    concurrency: queue.concurrency,
    durationMs: queue.durationMs,
    maxActiveCount: queue.maxActiveCount
  };
  run.status = run.failureCount > 0
    ? run.successCount > 0 ? "partial" : "failed"
    : "succeeded";
  run.changeRefresh = changeRefresh;
  run.seoRefresh = seoRefresh;
  run.textQualityRefresh = textQualityRefresh;
  for (const result of results) {
    if (result?.ok) {
      result.changeRefresh = changeRefresh;
      result.seoRefresh = seoRefresh;
      result.textQualityRefresh = textQualityRefresh;
    }
  }
  await appendCaptureRun(run).catch(() => null);
  Object.defineProperty(results, "captureRun", { value: run, enumerable: false });
  Object.defineProperty(results, "changeRefresh", { value: changeRefresh, enumerable: false });
  Object.defineProperty(results, "seoRefresh", { value: seoRefresh, enumerable: false });
  Object.defineProperty(results, "textQualityRefresh", { value: textQualityRefresh, enumerable: false });
  return results;
}

async function persistPreparedCaptureResult(result) {
  const snapshots = captureResultSnapshots(result);
  if (snapshots.length) {
    await appendSnapshots(snapshots);
  }
  const seoSnapshots = captureResultSeoSnapshots(result);
  if (seoSnapshots.length) {
    await appendSeoSnapshots(seoSnapshots);
  }
}

function createCaptureRunRecord(plans, options = {}) {
  const startedAt = new Date();
  const id = options.runId || `run-${startedAt.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    status: "running",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    totalCount: plans.length,
    successCount: 0,
    failureCount: 0,
    skippedCount: 0,
    concurrency: 1,
    changeRefresh: null,
    seoRefresh: null,
    textQualityRefresh: null,
    items: plans.map((plan, index) => captureRunItemForPlan(plan, id, index))
  };
}

function captureRunItemForPlan(plan, runId, index) {
  return {
    id: `${runId}-item-${index + 1}`,
    status: "pending",
    ok: null,
    targetId: plan.targetId || plan.target?.id || null,
    targetLabel: plan.target?.label || null,
    url: plan.target?.url || null,
    platform: plan.platform || null,
    deviceProfileId: plan.deviceProfileId || plan.deviceProfile?.id || null,
    devicePresetId: plan.devicePreset?.id || plan.deviceProfile?.devicePresetId || null,
    capturePlanId: plan.id || null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    snapshotIds: [],
    error: null
  };
}

function captureConcurrency(config, options = {}) {
  const value = options.maxConcurrency ??
    options.concurrency ??
    config.captureConcurrency ??
    process.env.CAPTURE_CONCURRENCY ??
    1;
  return boundedConcurrency(value, { defaultValue: 1, max: 8 });
}

function relatedCaptureConcurrency(config = {}, options = {}) {
  const value = options.relatedCaptureConcurrency ??
    config.relatedCaptureConcurrency ??
    process.env.RELATED_CAPTURE_CONCURRENCY ??
    1;
  return boundedConcurrency(value, { defaultValue: 1, max: 4 });
}

function captureRetryAttempts(config = {}, options = {}) {
  const value = options.captureRetryAttempts ??
    config.captureRetryAttempts ??
    process.env.CAPTURE_RETRY_ATTEMPTS ??
    2;
  return boundedConcurrency(value, { defaultValue: 2, max: 3 });
}

async function retryFailedCapturePlans({
  plans,
  config,
  options,
  run,
  results,
  savePreparedCaptureResult
}) {
  const maxAttempts = captureRetryAttempts(config, options);
  if (maxAttempts <= 1) {
    return;
  }

  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const retryIndexes = results
      .map((result, index) => shouldRetryCaptureResult(result) ? index : -1)
      .filter((index) => index >= 0);
    if (!retryIndexes.length) {
      return;
    }

    for (const planIndex of retryIndexes) {
      const execution = plans[planIndex];
      const item = run.items[planIndex];
      item.status = "retrying";
      item.retryCount = Number(item.retryCount || 0) + 1;
      const startedAt = Date.now();
      let result;
      try {
        result = await runCaptureExecution(execution, retryCaptureConfig(config, attempt), {
          ...options,
          captureBatchIndex: planIndex,
          captureRetryAttempt: attempt,
          deferSnapshotSave: true,
          deferChangeRefresh: true
        });
      } catch (error) {
        result = {
          ok: false,
          error: error?.message || String(error)
        };
      }
      result = failResultWithRetriableRelatedWarnings(result);
      if (result?.ok) {
        try {
          await savePreparedCaptureResult(result);
        } catch (error) {
          result.ok = false;
          result.error = `Capture completed but failed to save snapshot index: ${error.message}`;
        }
      }
      const retryDurationMs = Date.now() - startedAt;
      item.finishedAt = new Date().toISOString();
      item.durationMs = Number(item.durationMs || 0) + retryDurationMs;
      item.ok = Boolean(result?.ok);
      item.status = result?.ok ? "succeeded" : "failed";
      item.error = result?.ok ? null : result?.error || "Capture failed.";
      item.snapshotIds = captureResultSnapshots(result).map((snapshot) => snapshot.id).filter(Boolean);
      results[planIndex] = {
        ...result,
        runId: run.id,
        runItemId: item.id,
        runIndex: planIndex + 1,
        runTotal: plans.length,
        retryAttempt: attempt
      };
    }
  }
}

function shouldRetryCaptureResult(result) {
  if (captureResultRelatedWarnings(result).length) {
    return true;
  }
  const message = String(result?.error || "");
  return /failed blank-image validation|near-white blank band|related warnings/i.test(message);
}

function retryCaptureConfig(config, attempt) {
  return attempt > 1
    ? { ...config, relatedCaptureConcurrency: 1 }
    : config;
}

function failResultWithRetriableRelatedWarnings(result) {
  if (!result?.ok) {
    return result;
  }
  const warnings = captureResultRelatedWarnings(result);
  if (!warnings.length) {
    return result;
  }
  return {
    ...result,
    ok: false,
    error: `Capture completed with related warnings: ${relatedWarningSummary(warnings)}`
  };
}

function captureResultRelatedWarnings(result) {
  return captureResultSnapshots(result)
    .flatMap((snapshot) => Array.isArray(snapshot?.relatedValidation?.warnings)
      ? snapshot.relatedValidation.warnings
      : [])
    .filter(Boolean);
}

function relatedWarningSummary(warnings) {
  return warnings
    .slice(0, 3)
    .map((warning) => [
      warning.sectionLabel || warning.sectionKey || "related",
      warning.stateLabel,
      warning.message
    ].filter(Boolean).join(" / "))
    .join("; ");
}

function captureResultSnapshots(result) {
  if (!result?.ok) {
    return [];
  }
  if (Array.isArray(result.snapshots) && result.snapshots.length) {
    return result.snapshots;
  }
  return result.snapshot ? [result.snapshot] : [];
}

function captureResultSeoSnapshots(result) {
  if (!result?.ok || !Array.isArray(result.seoSnapshots)) {
    return [];
  }
  return result.seoSnapshots;
}

async function runCaptureExecution(execution, config, options = {}) {
  const runner = execution.platform === "mobile"
    ? captureMobilePlan
    : capturePcPlan;
  return runner(execution, config, options);
}

async function capturePcPlan(execution, config, options = {}) {
  return capturePlanExecution({ ...execution, platform: "pc" }, config, options);
}

async function captureMobilePlan(execution, config, options = {}) {
  return capturePlanExecution({ ...execution, platform: "mobile" }, config, options);
}

async function capturePlanExecution(execution, config, options = {}) {
  const target = execution.target;
  const normalizedUrl = target.url;
  const capturedAt = new Date(Date.now() + Math.max(0, Number(options.captureBatchIndex || 0)));
  const fileInfo = await createSnapshotFilePath(normalizedUrl, capturedAt);
  const devicePreset = execution.devicePreset || findDevicePreset(execution.deviceProfile?.devicePresetId || "");
  const publicDevice = devicePreset ? toPublicDevicePreset(devicePreset) : null;
  const captureConfig = captureConfigForExecution(config, execution, options);
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
      snapshots.push({
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
    }

    const seoSnapshots = createSeoSnapshotsForCapture(capture, snapshots);

    if (!options.deferSnapshotSave) {
      await appendSnapshots(snapshots);
      if (seoSnapshots.length) {
        await appendSeoSnapshots(seoSnapshots);
      }
    }
    const changeRefresh = options.deferChangeRefresh
      ? { ok: true, deferred: true }
      : await refreshChangeRecords();
    const seoRefresh = options.deferChangeRefresh
      ? { ok: true, deferred: true }
      : await refreshSeoChangeRecords();
    const textQualityRefresh = options.deferChangeRefresh
      ? { ok: true, deferred: true }
      : await refreshTextQualityRecords();
    recordCaptureDiagnostic(diagnosticRun, {
      type: options.deferSnapshotSave ? "snapshot-prepared" : "snapshot-write",
      ok: true,
      snapshotCount: snapshots.length,
      seoSnapshotCount: seoSnapshots.length,
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
      changeRefresh,
      seoRefresh,
      textQualityRefresh
    });
    await finalizeCaptureDiagnostic(diagnosticRun, {
      ok: true,
      targetId: target.id,
      requestedUrl: normalizedUrl,
      snapshotCount: snapshots.length,
      seoSnapshotCount: seoSnapshots.length,
      relatedShotCount: relatedShots.length,
      lowConfidenceSnapshotCount: snapshots.filter((snapshot) => snapshot.captureConfidence?.baselineEligible === false).length,
      lowConfidenceRelatedShotCount: relatedShots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length,
      warningCount: Array.isArray(relatedCapture.validation?.warnings) ? relatedCapture.validation.warnings.length : 0,
      changeRefresh,
      seoRefresh,
      textQualityRefresh
    });
    return {
      ok: true,
      platform: execution.platform,
      capturePlanId: execution.id || null,
      deviceProfileId: execution.deviceProfile?.id || null,
      snapshot: snapshots[0],
      snapshots,
      seoSnapshots,
      changeRefresh,
      seoRefresh,
      textQualityRefresh
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

async function refreshChangeRecords(options = {}) {
  try {
    const previousChanges = await loadChanges();
    const changes = await rebuildChanges();
    const notification = await notifyChangeRecords(changes, {
      previousChanges,
      sendNotifications: options.sendNotifications
    }).catch((error) => ({
      ok: false,
      enabled: true,
      error: error.message
    }));
    return { ok: true, count: changes.length, notification };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function refreshSeoChangeRecords() {
  try {
    const changes = await rebuildSeoChanges();
    return { ok: true, count: changes.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function refreshTextQualityRecords() {
  try {
    const records = await rebuildTextQuality();
    const issueCount = records.reduce((sum, record) => sum + Number(record.issueCount || 0), 0);
    return { ok: true, count: records.length, issueCount };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function captureConfigForExecution(config, execution, options = {}) {
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
  const relatedCaptureMode = execution.relatedCaptureMode || execution.target.relatedCaptureMode || null;
  const captureMode = execution.captureMode ||
    execution.target.captureMode ||
    mainCaptureModeForRelatedCaptureMode(relatedCaptureMode);
  if (captureMode) {
    targetConfig.captureMode = captureMode;
  }
  if (relatedCaptureMode) {
    targetConfig.relatedCaptureMode = relatedCaptureMode;
  }
  const relatedStateFilter = options.relatedStateFilter || execution.relatedStateFilter || null;
  if (relatedStateFilter && typeof relatedStateFilter === "object") {
    targetConfig.relatedStateFilter = relatedStateFilter;
  }
  const relatedStateOutputPath = stringOrNull(options.relatedStateOutputPath) || stringOrNull(execution.relatedStateOutputPath);
  if (relatedStateOutputPath) {
    targetConfig.relatedStateOutputPath = relatedStateOutputPath;
  }
  const sectionKey = stringOrNull(options.sectionKey) || stringOrNull(execution.sectionKey);
  if (sectionKey) {
    targetConfig.sectionKey = sectionKey;
  }
  return targetConfig;
}

function mainCaptureModeForRelatedCaptureMode(mode) {
  const normalized = stringOrNull(mode);
  return [
    "shokz-collection-page",
    "shokz-comparison-page",
    "shokz-landing-page"
  ].includes(normalized)
    ? normalized
    : null;
}

function createSeoSnapshotsForCapture(capture, snapshots) {
  if (!capture?.seoSnapshot || !Array.isArray(snapshots) || !snapshots.length) {
    return [];
  }
  const primarySnapshot = snapshots.find((snapshot) => !snapshot.bannerIndex) || snapshots[0];
  const seoSnapshot = createSeoSnapshotRecord({
    snapshot: primarySnapshot,
    seoSnapshot: capture.seoSnapshot
  });
  return seoSnapshot ? [seoSnapshot] : [];
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

function findHomeOverviewTileBySourceFile(snapshot, sourceFile) {
  const file = stringOrNull(sourceFile);
  const variants = snapshot?.homeOverview?.composite?.variants;
  if (!file || !Array.isArray(variants)) {
    return null;
  }
  return variants.find((variant) => fileMatchesReplacement(variant?.sourceFile, file)) || null;
}

function replacementTargetsHomeOverview(snapshot, input) {
  const previewFile = stringOrNull(input?.previewFile) || stringOrNull(input?.overviewFile);
  return stringOrNull(input?.imageKind) === "home-overview-composite" ||
    (previewFile && previewFile === snapshot?.homeOverview?.file);
}

function findRelatedShotForReplacement(snapshot, input) {
  const relatedShots = Array.isArray(snapshot?.relatedShots) ? snapshot.relatedShots : [];
  if (!relatedShots.length) {
    return null;
  }

  const previewFile = stringOrNull(input?.previewFile) || stringOrNull(input?.overviewFile);
  const sourceFile = stringOrNull(input?.sourceFile);
  const tileKey = stringOrNull(input?.tileKey) || "";
  const sectionKey = stringOrNull(input?.sectionKey);

  const exact = relatedShots.find((shot) =>
    fileMatchesReplacement(shot.file, previewFile) ||
    fileMatchesReplacement(shot.file, sourceFile)
  );
  if (exact) {
    return { shot: exact };
  }

  const byVariant = relatedShots.find((shot) =>
    Array.isArray(shot.composite?.variants) &&
    shot.composite.variants.some((variant) =>
      fileMatchesReplacement(variant.sourceFile, sourceFile) ||
      tileMatchesReplacement(variant, tileKey, input)
    )
  );
  if (byVariant) {
    return { shot: byVariant };
  }

  const byMetadata = relatedShots.find((shot) =>
    (!sectionKey || shot.sectionKey === sectionKey) &&
    tileMatchesReplacement(shot, tileKey, input)
  );
  return byMetadata ? { shot: byMetadata } : null;
}

function fileMatchesReplacement(candidate, requested) {
  const candidateFile = stringOrNull(candidate);
  const requestedFile = stringOrNull(requested);
  if (!candidateFile || !requestedFile) {
    return false;
  }
  return candidateFile === requestedFile ||
    candidateFile.endsWith(`/${requestedFile}`) ||
    requestedFile.endsWith(`/${candidateFile}`);
}

function tileMatchesReplacement(item, tileKey, input) {
  const values = [
    item?.key,
    item?.coverageKey,
    item?.logicalSignature,
    item?.stateLabel,
    item?.label,
    item?.categoryKey,
    item?.productKey,
    item?.variantKey,
    item?.hoverItemKey,
    item?.file,
    item?.sourceFile,
    input?.categoryKey,
    input?.productKey,
    input?.variantKey
  ].map((value) => stringOrNull(value)).filter(Boolean);
  return values.some((value) => value === tileKey || tileKey.includes(value));
}

function relatedReplacementCaptureMode(snapshot, relatedShot, input) {
  const sectionKey = stringOrNull(input?.sectionKey) || relatedShot?.sectionKey || "";
  if (sectionKey === "navigation" || snapshot?.targetId === "shokz-products-nav" || snapshot?.captureMode === "shokz-products-nav") {
    return "shokz-products-nav-related";
  }
  if (snapshot?.captureMode === "shokz-collection-page" ||
    shokzCollectionRelatedSectionDefinitions.some((definition) => definition.key === sectionKey)) {
    return "shokz-collection-related-section";
  }
  if (snapshot?.captureMode === "shokz-comparison-page" ||
    shokzComparisonRelatedSectionDefinitions.some((definition) => definition.key === sectionKey)) {
    return "shokz-comparison-related-section";
  }
  if (snapshot?.captureMode === "shokz-landing-page" ||
    sectionKey.startsWith("landing-")) {
    return "shokz-landing-related";
  }
  if (sectionKey === "banner") {
    return "shokz-home-banners";
  }
  if (shokzHomeRelatedSectionDefinitions.some((definition) => definition.key === sectionKey)) {
    return "shokz-home-related-section";
  }

  const error = new Error("Selected screenshot does not have a supported replacement capture mode");
  error.statusCode = 400;
  throw error;
}

function replacementFilterForRelatedShot(input, relatedShot, sourceFile) {
  return {
    tileKey: stringOrNull(input?.tileKey) || "",
    tileLabel: stringOrNull(input?.tileLabel) || stringOrNull(relatedShot?.label) || "",
    sectionKey: stringOrNull(input?.sectionKey) || relatedShot?.sectionKey || "",
    sourceFile: sourceFile || relatedShot?.file || "",
    relatedShotFile: relatedShot?.file || "",
    categoryKey: stringOrNull(input?.categoryKey) || relatedShot?.categoryKey || "",
    categoryLabel: stringOrNull(input?.categoryLabel) || relatedShot?.categoryLabel || "",
    productKey: stringOrNull(input?.productKey) || relatedShot?.productKey || "",
    productLabel: stringOrNull(input?.productLabel) || relatedShot?.productLabel || "",
    variantKey: stringOrNull(input?.variantKey) || relatedShot?.variantKey || "",
    variantLabel: stringOrNull(input?.variantLabel) || relatedShot?.variantLabel || "",
    tabLabel: stringOrNull(input?.tabLabel) || relatedShot?.tabLabel || "",
    pageIndex: input?.pageIndex || relatedShot?.pageIndex || null,
    wholeImage: Boolean(input?.wholeImage)
  };
}

function selectReplacementRelatedShot(replacementShots, previousShot, input) {
  const shots = Array.isArray(replacementShots) ? replacementShots : [];
  if (!shots.length) {
    return null;
  }
  return shots.find((shot) => shot.file === previousShot.file) ||
    shots.find((shot) => shot.sectionKey === previousShot.sectionKey && shot.categoryKey && shot.categoryKey === previousShot.categoryKey) ||
    shots.find((shot) => shot.sectionKey === previousShot.sectionKey && shot.coverageKey && shot.coverageKey === previousShot.coverageKey) ||
    shots.find((shot) => tileMatchesReplacement(shot, stringOrNull(input?.tileKey) || "", input)) ||
    shots[0];
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
  const relatedSourceMode = captureConfig.relatedCaptureMode || captureConfig.captureMode || null;
  if (target.id === "shokz-products-nav" || relatedSourceMode === "shokz-products-nav") {
    return "shokz-products-nav-related";
  }
  if (relatedSourceMode === "shokz-collection-page") {
    return "shokz-collection-related-section";
  }
  if (relatedSourceMode === "shokz-comparison-page") {
    return "shokz-comparison-related-section";
  }
  if (relatedSourceMode === "shokz-landing-page") {
    return "shokz-landing-related";
  }

  return null;
}

async function captureRelatedShotsForTarget(target, normalizedUrl, baseOutputPath, captureConfig, diagnosticRun = null) {
  const relatedSourceMode = captureConfig.relatedCaptureMode || captureConfig.captureMode || null;
  if (target.id === "shokz-home" && !relatedSourceMode) {
    return captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
  }
  if (relatedSourceMode === "shokz-collection-page") {
    return captureShokzCollectionRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
  }
  if (relatedSourceMode === "shokz-comparison-page") {
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

  const sortedShots = relatedShots.sort(compareRelatedShots);
  const overview = await composePageOverviewForRelatedShots(baseOutputPath, sortedShots, captureConfig, {
    sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation-overview" : "page-overview",
    sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation overview" : "Page overview"
  });
  const validationWithOverview = relatedValidationWithOverviewWarnings(validation, overview.warnings);

  recordCaptureDiagnostic(diagnosticRun, {
    type: "related-capture",
    ok: true,
    sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "related",
    sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation" : "More screenshots",
    captureMode: relatedMode,
    shotCount: sortedShots.length,
    warningCount: Array.isArray(validationWithOverview?.warnings) ? validationWithOverview.warnings.length : 0,
    lowConfidenceShotCount: sortedShots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length,
    captureValidation: summarizeCaptureValidationEntries(relatedCapture.captures || [])
  });
  return {
    shots: sortedShots,
    homeOverview: overview.homeOverview,
    validation: validationWithOverview
  };
}

async function captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const descriptors = relatedDescriptorsForCaptureConfig([
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
  ], captureConfig);
  const { shots, warnings, sections } = await captureIsolatedRelatedSections(
    normalizedUrl,
    baseOutputPath,
    captureConfig,
    descriptors,
    diagnosticRun
  );

  sections.sort(compareRelatedSectionEntries);
  const sortedShots = shots.sort(compareRelatedShots);
  const overview = await composePageOverviewForRelatedShots(baseOutputPath, sortedShots, captureConfig, {
    sectionKey: "home-overview",
    sectionLabel: "Home overview",
    sectionTitle: "Home overview",
    stateLabel: "Home overview",
    label: "Home overview",
    outputSuffix: "-home-overview-map.png"
  });
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

async function composePageOverviewForRelatedShots(baseOutputPath, relatedShots, captureConfig, options = {}) {
  const preparedShots = relatedShots
    .filter((shot) => shot?.file)
    .map((shot) => ({
      ...shot,
      outputPath: archiveAbsolutePath(shot.file)
    }));
  if (!preparedShots.length) {
    return { homeOverview: null, warnings: [] };
  }

  const sectionKey = options.sectionKey || "page-overview";
  const sectionLabel = options.sectionLabel || "Page overview";
  const sectionTitle = options.sectionTitle || sectionLabel;
  const stateLabel = options.stateLabel || `${sectionLabel} composite`;
  const label = options.label || stateLabel;
  const compositeShots = preparedShots.filter((shot) => shot.kind === "collection-tab-composite" && shot.composite);

  try {
    const overview = compositeShots.length
      ? await composeShokzHomeOverviewCompositeCapture({
          mainOutputPath: baseOutputPath,
          outputPath: pageOverviewOutputPath(baseOutputPath, options.outputSuffix || "-page-overview-map.png"),
          viewport: captureConfig.viewport || {},
          relatedShots: compositeShots
        })
      : await composeRawPageOverviewCompositeCapture({
          mainOutputPath: baseOutputPath,
          stateCaptures: preparedShots,
          viewport: captureConfig.viewport || {},
          sectionKey,
          sectionLabel,
          sectionTitle,
          stateLabel,
          label
        });
    return {
      homeOverview: await publicPageOverviewForCapture({
        ...overview,
        kind: "home-overview-composite",
        sectionKey,
        sectionLabel,
        sectionTitle,
        stateLabel,
        label,
        logicalSignature: `${sectionKey}|all-modules`,
        composite: overview.composite
          ? { ...overview.composite, sourceKind: sectionKey }
          : overview.composite
      }),
      warnings: []
    };
  } catch (error) {
    return {
      homeOverview: null,
      warnings: [{
        sectionKey,
        sectionLabel,
        message: `Could not compose page overview screenshot: ${error.message}`
      }]
    };
  }
}

function pageOverviewOutputPath(baseOutputPath, suffix) {
  return /\.png$/i.test(baseOutputPath)
    ? baseOutputPath.replace(/\.png$/i, suffix)
    : `${baseOutputPath}${suffix}`;
}

async function composeRawPageOverviewCompositeCapture({
  mainOutputPath,
  stateCaptures,
  viewport,
  sectionKey,
  sectionLabel,
  sectionTitle,
  stateLabel,
  label
}) {
  const compositeResult = await composeShokzHomeModuleCompositeCaptureFromFiles({
    mainOutputPath,
    stateCaptures,
    definition: {
      key: sectionKey,
      sectionLabel,
      title: sectionTitle
    },
    viewport
  });
  const [overview] = compositeResult.captures || [];
  if (!overview) {
    const warningText = compositeResult.warnings.map((warning) => warning.message).filter(Boolean).join("; ");
    throw new Error(warningText || "No page overview screenshot was produced.");
  }
  return {
    ...overview,
    sectionKey,
    sectionLabel,
    sectionTitle,
    stateLabel,
    label
  };
}

async function publicPageOverviewForCapture(overview) {
  const relativePath = archiveRelativePath(overview.outputPath);
  const stat = await fs.stat(overview.outputPath);
  return {
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
  };
}

function relatedValidationWithOverviewWarnings(validation, overviewWarnings = []) {
  const warnings = Array.isArray(overviewWarnings) ? overviewWarnings.filter(Boolean) : [];
  if (!warnings.length) {
    return validation;
  }
  return {
    ...(validation || {}),
    status: "warning",
    warnings: [
      ...((validation?.warnings || [])),
      ...warnings
    ],
    sections: validation?.sections || []
  };
}

async function captureShokzCollectionRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const descriptors = collectionRelatedDescriptorsForCaptureConfig(captureConfig);
  const { shots, warnings, sections } = await captureIsolatedRelatedSections(
    normalizedUrl,
    baseOutputPath,
    captureConfig,
    descriptors,
    diagnosticRun
  );

  sections.sort(compareRelatedSectionEntries);
  const sortedShots = shots.sort(compareRelatedShots);
  const overview = await composePageOverviewForRelatedShots(baseOutputPath, sortedShots, captureConfig, {
    sectionKey: "collection-overview",
    sectionLabel: "Collection overview"
  });
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

async function captureShokzComparisonRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const descriptors = comparisonRelatedDescriptorsForCaptureConfig(captureConfig);
  const { shots, warnings, sections } = await captureIsolatedRelatedSections(
    normalizedUrl,
    baseOutputPath,
    captureConfig,
    descriptors,
    diagnosticRun
  );

  sections.sort(compareRelatedSectionEntries);
  const sortedShots = shots.sort(compareRelatedShots);
  const overview = await composePageOverviewForRelatedShots(baseOutputPath, sortedShots, captureConfig, {
    sectionKey: "comparison-overview",
    sectionLabel: "Comparison overview"
  });
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

async function captureIsolatedRelatedSections(normalizedUrl, baseOutputPath, captureConfig, descriptors, diagnosticRun) {
  const shots = [];
  const warnings = [];
  const sections = [];
  const queue = await runJobQueue(descriptors, (descriptor) =>
    captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun), {
      concurrency: relatedCaptureConcurrency(captureConfig),
      maxConcurrency: 4,
      throwOnError: false
    });

  for (const entry of queue.results) {
    const result = entry?.value;
    if (!entry?.ok || !result) {
      const descriptor = entry?.job || {};
      warnings.push({
        sectionKey: descriptor.sectionKey || "related",
        sectionLabel: descriptor.sectionLabel || "More screenshots",
        message: entry?.errorMessage || "Related capture failed."
      });
      sections.push({
        sectionKey: descriptor.sectionKey || "related",
        sectionLabel: descriptor.sectionLabel || "More screenshots",
        expectedCount: 0,
        capturedCount: 0,
        savedCount: 0,
        status: "warning"
      });
      continue;
    }
    shots.push(...result.shots);
    warnings.push(...(result.validation?.warnings || []));
    sections.push(...(result.validation?.sections || []));
  }

  return {
    shots,
    warnings,
    sections,
    queue
  };
}

function collectionRelatedDescriptorsForCaptureConfig(captureConfig = {}) {
  const descriptors = relatedDescriptorsForCaptureConfig(shokzCollectionRelatedSectionDefinitions.map((definition) => ({
    sectionKey: definition.key,
    sectionLabel: definition.sectionLabel,
    captureMode: "shokz-collection-related-section",
    sectionCaptureKey: definition.key
  })), captureConfig);

  if (!isMobileRelatedCaptureConfig(captureConfig) || captureConfig.relatedStateFilter) {
    return descriptors;
  }

  return descriptors.flatMap((descriptor) => {
    if (descriptor.sectionKey !== "collection-tabs") {
      return [descriptor];
    }
    const definition = shokzCollectionRelatedSectionDefinitions.find((item) => item.key === descriptor.sectionKey);
    const states = Array.isArray(definition?.states) ? definition.states : [];
    return states.length
      ? states.map((state) => ({
          ...descriptor,
          sectionLabel: `${descriptor.sectionLabel} / ${state.stateLabel || state.tabLabel || state.categoryKey}`,
          relatedStateFilter: relatedFilterForCollectionState(descriptor.sectionKey, state),
          captureTimeoutMs: mobileCollectionRelatedSectionTimeoutMs
        }))
      : [descriptor];
  });
}

function comparisonRelatedDescriptorsForCaptureConfig(captureConfig = {}) {
  const descriptors = relatedDescriptorsForCaptureConfig(shokzComparisonRelatedSectionDefinitions.map((definition) => ({
    sectionKey: definition.key,
    sectionLabel: definition.sectionLabel,
    captureMode: "shokz-comparison-related-section",
    sectionCaptureKey: definition.key
  })), captureConfig);

  if (!isMobileRelatedCaptureConfig(captureConfig) || captureConfig.relatedStateFilter) {
    return descriptors;
  }

  return descriptors.map((descriptor) =>
    descriptor.sectionKey === "comparison-products"
      ? { ...descriptor, captureTimeoutMs: mobileComparisonProductMapTimeoutMs }
      : descriptor
  );
}

function relatedFilterForCollectionState(sectionKey, state = {}) {
  return {
    sectionKey,
    categoryKey: state.categoryKey || state.matchHandle || null,
    tabLabel: state.tabLabel || state.categoryLabel || state.stateLabel || null,
    tileKey: state.categoryKey || state.fileId || state.stateLabel || null
  };
}

function isMobileRelatedCaptureConfig(captureConfig = {}) {
  return captureConfig.platform === "mobile" || Boolean(captureConfig.viewport?.mobile);
}

function relatedDescriptorsForCaptureConfig(descriptors, captureConfig = {}) {
  const requestedSectionKey = stringOrNull(captureConfig.sectionKey) ||
    stringOrNull(captureConfig.relatedStateFilter?.sectionKey);
  if (!requestedSectionKey) {
    return descriptors;
  }
  const filtered = descriptors.filter((descriptor) => descriptor.sectionKey === requestedSectionKey);
  return filtered.length ? filtered : descriptors;
}

async function captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun) {
  let relatedCapture;
  try {
    relatedCapture = await capturePage(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: descriptor.captureMode,
      sectionKey: descriptor.sectionCaptureKey || null,
      relatedStateFilter: descriptor.relatedStateFilter || captureConfig.relatedStateFilter || null,
      captureTimeoutMs: descriptor.captureTimeoutMs || captureConfig.captureTimeoutMs,
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
  findRelatedShotForReplacement,
  relatedReplacementCaptureMode,
  replacementFilterForRelatedShot,
  relatedDescriptorsForCaptureConfig,
  relatedCaptureModeForTarget,
  relatedCaptureConcurrency,
  captureRetryAttempts,
  shouldRetryCaptureResult,
  resolveAdHocCaptureExecution,
  createCaptureRunRecord,
  captureConcurrency,
  runnerNameForPlatform
};

function runnerNameForPlatform(platform) {
  return platform === "mobile" ? "captureMobilePlan" : "capturePcPlan";
}
