import fs from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
import { loadChanges, rebuildChanges, rebuildChangesForNewSnapshots } from "./changes.js";
import { notifyChangeRecords, resolveChangeNotificationConfig } from "./change-notifier.js";
import { findDevicePreset, toPublicDevicePreset } from "./device-presets.js";
import { hashBuffer, visualAuditForBuffer, visualHashForBuffer } from "./image-audit.js";
import { boundedConcurrency, runJobQueue } from "./job-queue.js";
import { archiveDir, logsDir } from "./paths.js";
import { decodePng, encodePng } from "./png.js";
import { appendSeoSnapshots, createSeoSnapshotRecord, rebuildSeoChanges } from "./seo-snapshots.js";
import {
  shokzCollectionRelatedSectionDefinitions,
  shokzComparisonRelatedSectionDefinitions,
  shokzComparisonProductMapStates,
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
import { syncArchiveFileToObjectStorage } from "./storage/object-storage.js";
import { rebuildTextQuality } from "./text-quality.js";
import { appendTrackingAuditRecords, createTrackingAuditRecordsForSnapshots } from "./tracking-audit.js";

const splitRelatedSectionTimeoutMs = 2 * 60 * 1000;
const collectionRelatedSectionTimeoutMs = splitRelatedSectionTimeoutMs;
const mobileComparisonProductMapTimeoutMs = 55 * 60 * 1000;
const comparisonProductStateTimeoutMs = splitRelatedSectionTimeoutMs;
const homeRelatedSectionTimeoutMs = splitRelatedSectionTimeoutMs;
const networkPreflightDiagnosticsPath = path.join(logsDir, "network-preflight-diagnostics.jsonl");

export async function captureConfiguredUrls(config = null, options = {}) {
  const activeConfig = normalizeConfig(config || await loadConfig());
  const plans = resolveConfiguredCapturePlans(activeConfig, options);
  const runOptions = {
    ...options,
    fastRelated: options.fastRelated ?? process.env.PAGE_SHOT_DEEP_RELATED !== "1",
    fastMainCapture: options.fastMainCapture ?? process.env.PAGE_SHOT_DEEP_RELATED !== "1"
  };
  return withCaptureLock(async () => {
    const preflight = await runCaptureNetworkPreflight(plans, activeConfig, runOptions);
    if (!preflight.ok) {
      return skipCaptureRunForNetworkPreflight(plans, activeConfig, runOptions, preflight);
    }
    return runResolvedCapturePlans(plans, activeConfig, { ...runOptions, networkPreflight: preflight });
  });
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
  const browserConcurrency = captureBrowserConcurrency(config, options);
  const browserLimiter = options.browserLimiter || createBrowserSlotLimiter(browserConcurrency);
  run.concurrency = concurrency;
  run.browserConcurrency = browserConcurrency;

  async function runPlan(execution, { index: planIndex }) {
    const item = run.items[planIndex];
    item.status = "running";
    item.startedAt = new Date().toISOString();
    const startedAt = Date.now();
    let result;
    try {
      result = await runCaptureExecution(execution, config, {
        ...options,
        browserLimiter,
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

  const queue = await runJobQueue(plans, runPlan, {
    concurrency,
    maxConcurrency: 10,
    throwOnError: false
  });
  run.browserMaxActiveCount = browserLimiter.stats?.maxActiveCount || 0;
  await retryFailedCapturePlans({
    plans,
    config,
    options,
    run,
    results,
    browserLimiter
  });
  run.browserMaxActiveCount = browserLimiter.stats?.maxActiveCount || run.browserMaxActiveCount || 0;

  const persistence = await persistPreparedCaptureResultsForRun(results, run);
  const changeRefresh = options.deferChangeRefresh
    ? { ok: true, deferred: true }
    : await refreshChangeRecords({
        incrementalSnapshots: persistence.ok && options.incrementalChangeRefresh !== false
          ? persistence.snapshots
          : null
      });
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
  run.networkPreflight = options.networkPreflight || null;
  run.persistence = persistence.summary;
  for (const result of results) {
    if (result?.ok) {
      result.changeRefresh = changeRefresh;
      result.seoRefresh = seoRefresh;
      result.textQualityRefresh = textQualityRefresh;
    }
  }
  await appendCaptureRun(run, { filePath: options.captureRunsFilePath }).catch(() => null);
  Object.defineProperty(results, "captureRun", { value: run, enumerable: false });
  Object.defineProperty(results, "changeRefresh", { value: changeRefresh, enumerable: false });
  Object.defineProperty(results, "seoRefresh", { value: seoRefresh, enumerable: false });
  Object.defineProperty(results, "textQualityRefresh", { value: textQualityRefresh, enumerable: false });
  return results;
}

async function runCaptureNetworkPreflight(plans, config = {}, options = {}) {
  const settings = captureNetworkPreflightSettings(config, options);
  if (!settings.enabled || !Array.isArray(plans) || !plans.length) {
    return { ok: true, enabled: settings.enabled, skipped: true, checks: [] };
  }

  const checks = captureNetworkPreflightChecks(plans, options);
  if (!checks.length) {
    return { ok: true, enabled: settings.enabled, checks: [] };
  }

  let lastAttempt = null;
  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    const results = [];
    for (const check of checks) {
      results.push(await runNetworkPreflightCheck(check, settings));
    }
    lastAttempt = { attempt, checks: results };
    if (networkPreflightTargetsPassed(results)) {
      return {
        ok: true,
        enabled: true,
        attempts: attempt,
        checks: results,
        retryDelayMs: settings.retryDelayMs,
        warning: results.some((result) => !result.ok),
        reason: results.some((result) => !result.ok) ? "network-preflight-warning" : null,
        message: results.some((result) => !result.ok) ? networkPreflightWarningMessage(results) : null
      };
    }
    if (attempt < settings.attempts) {
      await settings.sleep(settings.retryDelayMs);
    }
  }

  const failedChecks = lastAttempt?.checks || [];
  const diagnostics = settings.diagnosticsEnabled
    ? await collectNetworkPreflightDiagnostics(failedChecks, settings)
    : null;
  if (diagnostics) {
    await appendNetworkPreflightDiagnostics(diagnostics, settings).catch(() => null);
  }

  if (networkPreflightCanContinue(failedChecks, diagnostics)) {
    return {
      ok: true,
      enabled: true,
      attempts: settings.attempts,
      retryDelayMs: settings.retryDelayMs,
      checks: failedChecks,
      diagnostics,
      warning: true,
      reason: "network-preflight-warning",
      message: networkPreflightWarningMessage(failedChecks)
    };
  }

  return {
    ok: false,
    enabled: true,
    attempts: settings.attempts,
    retryDelayMs: settings.retryDelayMs,
    checks: failedChecks,
    diagnostics,
    reason: "network-unavailable",
    message: networkPreflightFailureMessage(failedChecks)
  };
}

function captureNetworkPreflightSettings(config = {}, options = {}) {
  const env = options.env || process.env;
  return {
    enabled: booleanOption(options.networkPreflightEnabled ?? env.CAPTURE_NETWORK_PREFLIGHT_ENABLED, true),
    attempts: clampInteger(
      options.networkPreflightAttempts ?? config.networkPreflightAttempts ?? env.CAPTURE_NETWORK_PREFLIGHT_ATTEMPTS,
      1,
      10,
      3
    ),
    retryDelayMs: clampInteger(
      options.networkPreflightRetryDelayMs ?? config.networkPreflightRetryDelayMs ?? env.CAPTURE_NETWORK_PREFLIGHT_RETRY_DELAY_MS,
      0,
      30 * 60 * 1000,
      5 * 60 * 1000
    ),
    timeoutMs: clampInteger(
      options.networkPreflightTimeoutMs ?? config.networkPreflightTimeoutMs ?? env.CAPTURE_NETWORK_PREFLIGHT_TIMEOUT_MS,
      1000,
      120000,
      30000
    ),
    fetchImpl: options.fetchImpl || globalThis.fetch,
    probe: options.networkPreflightProbe || null,
    diagnosticsEnabled: booleanOption(
      options.networkPreflightDiagnosticsEnabled ?? env.CAPTURE_NETWORK_PREFLIGHT_DIAGNOSTICS_ENABLED,
      true
    ),
    diagnosticsProbe: options.networkPreflightDiagnosticsProbe || null,
    diagnosticsFilePath: options.networkPreflightDiagnosticsFilePath || networkPreflightDiagnosticsPath,
    commandRunner: options.networkPreflightCommandRunner || runCommand,
    sleep: options.networkPreflightSleep || sleep
  };
}

function captureNetworkPreflightChecks(plans, options = {}) {
  const checks = [];
  const seenOrigins = new Set();
  for (const plan of plans) {
    const url = stringOrNull(plan?.target?.url || plan?.url);
    if (!url) {
      continue;
    }
    try {
      const parsed = new URL(url);
      const key = parsed.origin.toLowerCase();
      if (seenOrigins.has(key)) {
        continue;
      }
      seenOrigins.add(key);
      checks.push({
        type: "capture-target",
        label: parsed.hostname,
        url: `${parsed.origin}/`
      });
    } catch {
      checks.push({
        type: "capture-target",
        label: url,
        url
      });
    }
  }

  const notificationConfig = resolveChangeNotificationConfig(options.env || process.env, options.changeNotification || {});
  if (notificationConfig.enabled && notificationConfig.webhook) {
    try {
      const webhookUrl = new URL(notificationConfig.webhook);
      checks.push({
        type: "dingtalk-webhook",
        label: webhookUrl.hostname,
        url: webhookUrl.origin
      });
    } catch {
      checks.push({
        type: "dingtalk-webhook",
        label: "DingTalk webhook",
        url: notificationConfig.webhook
      });
    }
  }

  return checks;
}

function networkPreflightTargetsPassed(checks) {
  return checks
    .filter((check) => check.type === "capture-target")
    .every((check) => check.ok);
}

function networkPreflightCanContinue(checks, diagnostics = null) {
  const captureTargetChecks = checks.filter((check) => check.type === "capture-target");
  const captureTargetFailures = captureTargetChecks.filter((check) => !check.ok);
  if (!captureTargetFailures.length) {
    return true;
  }
  if (captureTargetFailures.length < captureTargetChecks.length) {
    return true;
  }
  return !captureTargetFailures.every((check) => isHardDnsPreflightFailure(check, diagnostics));
}

function isHardDnsPreflightFailure(check, diagnostics = null) {
  const codes = networkPreflightFailureCodes(check.errorDetails);
  if (codes.some((code) => hardDnsFailureCodes.has(code))) {
    return true;
  }
  const diagnostic = networkPreflightDiagnosticForCheck(check, diagnostics);
  if (Array.isArray(diagnostic?.dns?.lookup) && diagnostic.dns.lookup.length > 0) {
    return false;
  }
  const lookupCodes = networkPreflightFailureCodes(diagnostic?.dns?.lookupError);
  return lookupCodes.some((code) => hardDnsFailureCodes.has(code));
}

const hardDnsFailureCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ERR_NAME_NOT_RESOLVED"]);

function networkPreflightFailureCodes(details, codes = []) {
  if (!details || typeof details !== "object") {
    return codes;
  }
  if (details.code) {
    codes.push(String(details.code));
  }
  if (details.cause && typeof details.cause === "object") {
    networkPreflightFailureCodes(details.cause, codes);
  }
  return codes;
}

function networkPreflightDiagnosticForCheck(check, diagnostics = null) {
  const diagnosticChecks = Array.isArray(diagnostics?.checks) ? diagnostics.checks : [];
  return diagnosticChecks.find((entry) =>
    (entry.type && entry.type === check.type && entry.label === check.label) ||
    (entry.url && entry.url === check.url)
  ) || null;
}

async function runNetworkPreflightCheck(check, settings) {
  if (typeof settings.probe === "function") {
    return normalizeNetworkPreflightResult(check, await settings.probe(check, settings));
  }
  if (typeof settings.fetchImpl !== "function") {
    return { ...check, ok: false, error: "fetch-unavailable" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await settings.fetchImpl(check.url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal
    });
    return {
      ...check,
      ok: Boolean(response?.ok),
      status: Number(response?.status || 0) || null,
      error: response?.ok ? null : `HTTP ${response?.status || "unknown"}`
    };
  } catch (error) {
    return {
      ...check,
      ok: false,
      error: error?.name === "AbortError" ? `timeout after ${settings.timeoutMs}ms` : error?.message || String(error),
      errorDetails: networkPreflightErrorDetails(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeNetworkPreflightResult(check, result = {}) {
  return {
    ...check,
    ok: Boolean(result.ok),
    status: Number.isFinite(Number(result.status)) ? Number(result.status) : null,
    error: result.ok ? null : stringOrNull(result.error) || "network check failed",
    errorDetails: result.ok ? null : result.errorDetails || null
  };
}

async function collectNetworkPreflightDiagnostics(checks, settings) {
  const failedChecks = checks.filter((check) => !check.ok);
  if (!failedChecks.length) {
    return null;
  }
  if (typeof settings.diagnosticsProbe === "function") {
    return normalizeNetworkPreflightDiagnostics(await settings.diagnosticsProbe(failedChecks, settings));
  }

  const startedAt = new Date();
  const diagnostics = {
    id: `network-preflight-${startedAt.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: startedAt.toISOString(),
    environment: await collectNetworkEnvironmentSnapshot(settings),
    checks: []
  };

  for (const check of failedChecks) {
    diagnostics.checks.push(await collectNetworkPreflightCheckDiagnostics(check, settings));
  }

  diagnostics.finishedAt = new Date().toISOString();
  diagnostics.failedCheckCount = diagnostics.checks.length;
  return diagnostics;
}

function normalizeNetworkPreflightDiagnostics(diagnostics = {}) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return null;
  }
  return {
    id: stringOrNull(diagnostics.id) || `network-preflight-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    startedAt: stringOrNull(diagnostics.startedAt) || new Date().toISOString(),
    finishedAt: stringOrNull(diagnostics.finishedAt) || new Date().toISOString(),
    environment: diagnostics.environment || null,
    failedCheckCount: Number.isFinite(Number(diagnostics.failedCheckCount))
      ? Number(diagnostics.failedCheckCount)
      : Array.isArray(diagnostics.checks) ? diagnostics.checks.length : 0,
    checks: Array.isArray(diagnostics.checks) ? diagnostics.checks : []
  };
}

async function collectNetworkPreflightCheckDiagnostics(check, settings) {
  const target = networkPreflightTarget(check);
  return {
    type: check.type || null,
    label: check.label || null,
    url: check.url || null,
    fetch: {
      ok: Boolean(check.ok),
      status: check.status || null,
      error: check.error || null,
      errorDetails: check.errorDetails || null
    },
    dns: target.host ? await dnsDiagnostics(target.host) : { ok: false, error: "missing-host" },
    tcp443: target.host ? await tcpDiagnostics(target.host, target.port || 443, settings) : { ok: false, error: "missing-host" },
    curlHead: check.url ? await curlHeadDiagnostics(check.url, settings) : { ok: false, error: "missing-url" }
  };
}

function networkPreflightTarget(check) {
  try {
    const parsed = new URL(check.url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === "http:" ? 80 : 443)),
      protocol: parsed.protocol
    };
  } catch {
    return { host: stringOrNull(check.label), port: 443, protocol: "https:" };
  }
}

async function dnsDiagnostics(host) {
  const diagnostics = { host };
  try {
    diagnostics.lookup = (await dns.lookup(host, { all: true })).map((entry) => ({
      address: entry.address,
      family: entry.family
    }));
    diagnostics.ok = true;
  } catch (error) {
    diagnostics.ok = false;
    diagnostics.lookupError = networkPreflightErrorDetails(error);
  }

  diagnostics.resolve4 = await dnsResolveDiagnostics(host, "resolve4");
  diagnostics.resolve6 = await dnsResolveDiagnostics(host, "resolve6");
  diagnostics.resolveCname = await dnsResolveDiagnostics(host, "resolveCname");
  return diagnostics;
}

async function dnsResolveDiagnostics(host, method) {
  try {
    return { ok: true, records: await dns[method](host) };
  } catch (error) {
    return { ok: false, errorDetails: networkPreflightErrorDetails(error) };
  }
}

function tcpDiagnostics(host, port, settings) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve({
        host,
        port,
        durationMs: Date.now() - startedAt,
        ...result
      });
    };
    socket.setTimeout(Math.min(settings.timeoutMs || 15000, 20000));
    socket.once("connect", () => {
      finish({
        ok: true,
        localAddress: socket.localAddress || null,
        localPort: socket.localPort || null,
        remoteAddress: socket.remoteAddress || null,
        remotePort: socket.remotePort || null,
        remoteFamily: socket.remoteFamily || null
      });
    });
    socket.once("timeout", () => {
      finish({ ok: false, error: `timeout after ${Math.min(settings.timeoutMs || 15000, 20000)}ms` });
    });
    socket.once("error", (error) => {
      finish({ ok: false, error: error.message, errorDetails: networkPreflightErrorDetails(error) });
    });
  });
}

async function curlHeadDiagnostics(url, settings) {
  const maxTimeSeconds = Math.max(1, Math.ceil(Math.min(settings.timeoutMs || 15000, 30000) / 1000));
  const result = await settings.commandRunner("curl.exe", [
    "-sS",
    "-I",
    "-L",
    "--max-time",
    String(maxTimeSeconds),
    url
  ], { timeoutMs: Math.min(settings.timeoutMs || 15000, 30000) });
  if (result.spawnError && result.spawnError.code === "ENOENT") {
    return settings.commandRunner("curl", [
      "-sS",
      "-I",
      "-L",
      "--max-time",
      String(maxTimeSeconds),
      url
    ], { timeoutMs: Math.min(settings.timeoutMs || 15000, 30000) });
  }
  return result;
}

async function collectNetworkEnvironmentSnapshot(settings) {
  const snapshot = {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    networkInterfaces: networkInterfaceSnapshot()
  };
  const wlan = await settings.commandRunner("netsh", ["wlan", "show", "interfaces"], { timeoutMs: 5000 });
  snapshot.wlan = {
    ok: wlan.exitCode === 0,
    parsed: wlan.exitCode === 0 ? parseNetshWlanInterfaces(wlan.stdout) : null,
    command: trimCommandResult(wlan)
  };
  return snapshot;
}

function networkInterfaceSnapshot() {
  const rows = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal) {
        continue;
      }
      rows.push({
        name,
        address: entry.address,
        family: entry.family,
        mac: entry.mac,
        cidr: entry.cidr || null
      });
    }
  }
  return rows;
}

function parseNetshWlanInterfaces(stdout) {
  const fields = {};
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
    fields[key] = match[2].trim();
  }
  return {
    name: fields.name || null,
    state: fields.state || null,
    ssid: fields.ssid || null,
    bssid: fields.bssid || fields.ap_bssid || null,
    signal: fields.signal || null,
    profile: fields.profile || null,
    radioType: fields.radio_type || null,
    authentication: fields.authentication || null
  };
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({
        command,
        args,
        ok: false,
        spawnError: networkPreflightErrorDetails(error),
        durationMs: Date.now() - startedAt
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15000);
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill();
      settled = true;
      resolve({
        command,
        args,
        ok: false,
        timedOut: true,
        exitCode: null,
        signal: null,
        stdout: limitDiagnosticText(stdout),
        stderr: limitDiagnosticText(stderr),
        durationMs: Date.now() - startedAt
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      resolve({
        command,
        args,
        ok: false,
        spawnError: networkPreflightErrorDetails(error),
        stdout: limitDiagnosticText(stdout),
        stderr: limitDiagnosticText(stderr),
        durationMs: Date.now() - startedAt
      });
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      resolve({
        command,
        args,
        ok: exitCode === 0,
        exitCode,
        signal,
        stdout: limitDiagnosticText(stdout),
        stderr: limitDiagnosticText(stderr),
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function trimCommandResult(result) {
  return {
    command: result.command,
    args: result.args,
    ok: result.ok,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: Boolean(result.timedOut),
    spawnError: result.spawnError || null,
    stdout: limitDiagnosticText(result.stdout || ""),
    stderr: limitDiagnosticText(result.stderr || ""),
    durationMs: result.durationMs || null
  };
}

function networkPreflightErrorDetails(error) {
  if (!error || typeof error !== "object") {
    return null;
  }
  const details = {
    name: error.name || null,
    message: error.message || String(error),
    code: error.code || null,
    errno: error.errno || null,
    syscall: error.syscall || null,
    address: error.address || null,
    port: error.port || null
  };
  if (error.cause && typeof error.cause === "object") {
    details.cause = networkPreflightErrorDetails(error.cause);
  }
  return details;
}

async function appendNetworkPreflightDiagnostics(diagnostics, settings) {
  if (!diagnostics) {
    return;
  }
  await fs.mkdir(path.dirname(settings.diagnosticsFilePath), { recursive: true });
  await fs.appendFile(settings.diagnosticsFilePath, `${JSON.stringify(diagnostics)}\n`, "utf8");
}

function limitDiagnosticText(value) {
  const text = redactDiagnosticText(String(value || ""));
  return text.length > 12000 ? text.slice(0, 12000) : text;
}

function redactDiagnosticText(text) {
  return text
    .replace(/^set-cookie:\s*.+$/gim, "set-cookie: [redacted]")
    .replace(/(access_token=)[^&\s]+/gim, "$1[redacted]")
    .replace(/(sign=)[^&\s]+/gim, "$1[redacted]");
}

async function skipCaptureRunForNetworkPreflight(plans, config, options, preflight) {
  const run = createCaptureRunRecord(plans, options);
  const finishedAt = new Date();
  const message = preflight.message || "Network preflight failed; capture skipped.";
  run.status = "skipped";
  run.finishedAt = finishedAt.toISOString();
  run.durationMs = finishedAt.getTime() - new Date(run.startedAt).getTime();
  run.totalCount = plans.length;
  run.successCount = 0;
  run.failureCount = 0;
  run.skippedCount = plans.length;
  run.concurrency = 0;
  run.jobQueue = {
    totalCount: plans.length,
    concurrency: 0,
    durationMs: run.durationMs,
    maxActiveCount: 0
  };
  run.changeRefresh = {
    ok: true,
    skipped: true,
    reason: preflight.reason || "network-unavailable"
  };
  run.seoRefresh = { ok: true, skipped: true };
  run.textQualityRefresh = { ok: true, skipped: true };
  run.networkPreflight = preflight;
  for (const item of run.items) {
    item.status = "skipped";
    item.ok = null;
    item.startedAt = run.startedAt;
    item.finishedAt = run.finishedAt;
    item.durationMs = run.durationMs;
    item.error = message;
  }
  await appendCaptureRun(run, { filePath: options.captureRunsFilePath }).catch(() => null);

  const results = plans.map((plan, index) => ({
    ok: true,
    skipped: true,
    error: message,
    networkPreflight: preflight,
    targetId: plan.targetId || plan.target?.id || null,
    targetLabel: plan.target?.label || null,
    displayUrl: plan.target?.label || plan.target?.url || null,
    url: plan.target?.url || null,
    platform: plan.platform || null,
    deviceProfileId: plan.deviceProfileId || plan.deviceProfile?.id || null,
    capturePlanId: plan.id || null,
    runId: run.id,
    runItemId: run.items[index]?.id || null,
    runIndex: index + 1,
    runTotal: plans.length
  }));
  Object.defineProperty(results, "captureRun", { value: run, enumerable: false });
  Object.defineProperty(results, "changeRefresh", { value: run.changeRefresh, enumerable: false });
  Object.defineProperty(results, "seoRefresh", { value: run.seoRefresh, enumerable: false });
  Object.defineProperty(results, "textQualityRefresh", { value: run.textQualityRefresh, enumerable: false });
  return results;
}

function networkPreflightFailureMessage(checks) {
  const failed = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.label || check.url}: ${check.error || "unavailable"}`);
  return failed.length
    ? `Network preflight failed; capture skipped. ${failed.join("; ")}`
    : "Network preflight failed; capture skipped.";
}

function networkPreflightWarningMessage(checks) {
  const failed = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.label || check.url}: ${check.error || "unavailable"}`);
  return failed.length
    ? `Network preflight had non-blocking failures; continuing capture. ${failed.join("; ")}`
    : null;
}

async function persistPreparedCaptureResultsForRun(results, run) {
  try {
    const persistence = await persistPreparedCaptureResults(results);
    return {
      ...persistence,
      ok: true,
      summary: {
        ok: true,
        batch: true,
        snapshotCount: persistence.snapshots.length,
        seoSnapshotCount: persistence.seoSnapshots.length,
        trackingAuditRecordCount: persistence.trackingAuditRecords.length
      }
    };
  } catch (error) {
    const message = `Capture completed but failed to save prepared batch: ${error.message}`;
    for (const [index, result] of results.entries()) {
      if (!result?.ok) {
        continue;
      }
      result.ok = false;
      result.error = message;
      const item = run.items[index];
      if (item) {
        item.ok = false;
        item.status = "failed";
        item.error = message;
      }
    }
    return {
      ok: false,
      snapshots: [],
      seoSnapshots: [],
      trackingAuditRecords: [],
      summary: {
        ok: false,
        batch: true,
        error: message,
        snapshotCount: 0,
        seoSnapshotCount: 0,
        trackingAuditRecordCount: 0
      }
    };
  }
}

async function persistPreparedCaptureResults(results) {
  const successfulResults = (Array.isArray(results) ? results : [])
    .filter((result) => result?.ok);
  const snapshots = successfulResults.flatMap(captureResultSnapshots);
  if (snapshots.length) {
    await appendSnapshots(snapshots);
  }
  const seoSnapshots = successfulResults.flatMap(captureResultSeoSnapshots);
  if (seoSnapshots.length) {
    await appendSeoSnapshots(seoSnapshots);
  }
  const trackingAuditRecords = successfulResults.flatMap(captureResultTrackingAuditRecords);
  if (trackingAuditRecords.length) {
    await appendTrackingAuditRecords(trackingAuditRecords);
  }
  return {
    snapshots,
    seoSnapshots,
    trackingAuditRecords
  };
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
    10;
  return boundedConcurrency(value, { defaultValue: 10, max: 10 });
}

function relatedCaptureConcurrency(config = {}, options = {}) {
  const value = options.relatedCaptureConcurrency ??
    config.relatedCaptureConcurrency ??
    process.env.RELATED_CAPTURE_CONCURRENCY ??
    3;
  return boundedConcurrency(value, { defaultValue: 3, max: 3 });
}

function captureBrowserConcurrency(config = {}, options = {}) {
  const value = options.captureBrowserConcurrency ??
    config.captureBrowserConcurrency ??
    process.env.CAPTURE_BROWSER_CONCURRENCY ??
    6;
  return boundedConcurrency(value, { defaultValue: 6, max: 6 });
}

function createBrowserSlotLimiter(maxConcurrency) {
  const concurrency = boundedConcurrency(maxConcurrency, { defaultValue: 6, max: 6 });
  const stats = {
    concurrency,
    activeCount: 0,
    maxActiveCount: 0,
    queuedCount: 0
  };
  const queue = [];

  async function acquire() {
    if (stats.activeCount < concurrency) {
      stats.activeCount += 1;
      stats.maxActiveCount = Math.max(stats.maxActiveCount, stats.activeCount);
      return;
    }
    stats.queuedCount += 1;
    await new Promise((resolve) => queue.push(resolve));
    stats.queuedCount -= 1;
  }

  return Object.assign(async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) {
        next();
      } else {
        stats.activeCount -= 1;
      }
    }
  }, { stats });
}

function capturePageWithBrowserSlot(url, outputPath, captureConfig, options = {}) {
  const limiter = options.browserLimiter;
  if (typeof limiter !== "function") {
    return capturePage(url, outputPath, captureConfig);
  }
  return limiter(() => capturePage(url, outputPath, captureConfig));
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
  browserLimiter
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

    await runJobQueue(retryIndexes, async (planIndex) => {
      const execution = plans[planIndex];
      const item = run.items[planIndex];
      item.status = "retrying";
      item.retryCount = Number(item.retryCount || 0) + 1;
      const startedAt = Date.now();
      let result;
      try {
        result = await runCaptureExecution(execution, retryCaptureConfig(config, attempt), {
          ...options,
          browserLimiter,
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
      return results[planIndex];
    }, {
      concurrency: captureConcurrency(config, options),
      maxConcurrency: 10,
      throwOnError: false
    });
  }
}

function shouldRetryCaptureResult(result) {
  const message = String(result?.error || "");
  return /failed blank-image validation|near-white blank band|related warnings|trigger not found|Mobile menu trigger not found|Shokz products navigation did not open|chrome-error:\/\/chromewebdata|URL check failed|Could not find|did not become active|net::ERR|Navigation timeout|Target closed/i.test(message);
}

function retryCaptureConfig(config, attempt) {
  return attempt > 1
    ? { ...config, relatedCaptureConcurrency: 1 }
    : config;
}

function failResultWithRetriableRelatedWarnings(result) {
  return result;
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

function captureResultTrackingAuditRecords(result) {
  if (!result?.ok || !Array.isArray(result.trackingAuditRecords)) {
    return [];
  }
  return result.trackingAuditRecords;
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
    const capture = await capturePageWithBrowserSlot(normalizedUrl, fileInfo.absolutePath, captureConfig, options);
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
    const relatedCapture = options.fastCaptureOnly
      ? emptyRelatedCapture()
      : await captureRelatedShotsForTarget(
        target,
        normalizedUrl,
        fileInfo.absolutePath,
        captureConfig,
        diagnosticRun,
        options
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
      const snapshotId = `${stamp}-${fileInfo.siteSlug}-${itemTargetId}-${execution.id || publicDevice?.id || "device"}`;
      const storage = await syncArchiveFileToObjectStorage({
        absolutePath,
        relativePath,
        snapshotId
      });
      const visualAudit = item.visualAudit || capture.visualAudit || null;
      const captureConfidence = assessSnapshotConfidence({
        visualAudit,
        urlCheck: capture.urlCheck || null
      });
      snapshots.push({
        id: snapshotId,
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
        imageUrl: storage.objectImageUrl || publicSnapshotUrl(relativePath),
        localImageUrl: publicSnapshotUrl(relativePath),
        localPath: storage.localPath,
        ossKey: storage.ossKey,
        syncStatus: storage.syncStatus,
        sha256: storage.sha256,
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

    const seoSnapshots = options.fastCaptureOnly ? [] : createSeoSnapshotsForCapture(capture, snapshots);
    const trackingAuditRecords = options.fastCaptureOnly
      ? []
      : createTrackingAuditRecordsForSnapshots({
        snapshots,
        capture,
        relatedTrackingAudits: relatedCapture.trackingAudits || []
      });

    if (!options.deferSnapshotSave) {
      await appendSnapshots(snapshots);
      if (seoSnapshots.length) {
        await appendSeoSnapshots(seoSnapshots);
      }
      if (trackingAuditRecords.length) {
        await appendTrackingAuditRecords(trackingAuditRecords);
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
      trackingAuditRecordCount: trackingAuditRecords.length,
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
      trackingAuditRecordCount: trackingAuditRecords.length,
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
      trackingAuditRecords,
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
    const incrementalSnapshots = Array.isArray(options.incrementalSnapshots)
      ? options.incrementalSnapshots
      : null;
    const changes = incrementalSnapshots
      ? await rebuildChangesForNewSnapshots(incrementalSnapshots, {
          ...options,
          previousChanges
        })
      : await rebuildChanges();
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
  if (options.fastMainCapture && captureMode !== "shokz-products-nav") {
    targetConfig.fullPage = false;
    targetConfig.lazyLoadScroll = false;
    targetConfig.maxAttempts = Math.min(2, Math.max(1, Number(targetConfig.maxAttempts) || 2));
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

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }
  return fallback;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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

async function captureRelatedShotsForTarget(target, normalizedUrl, baseOutputPath, captureConfig, diagnosticRun = null, options = {}) {
  const relatedSourceMode = captureConfig.relatedCaptureMode || captureConfig.captureMode || null;
  if (shouldSkipRelatedForFastAutomation(target, captureConfig, options)) {
    return captureFastRelatedOverview(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
  }
  if (target.id === "shokz-home" && !relatedSourceMode) {
    return captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun, options);
  }
  if (relatedSourceMode === "shokz-collection-page") {
    return captureShokzCollectionRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun, options);
  }
  if (relatedSourceMode === "shokz-comparison-page") {
    return captureShokzComparisonRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun, options);
  }

  const relatedMode = relatedCaptureModeForTarget(target, captureConfig);
  if (!relatedMode) {
    const overview = await composePageOverviewForRelatedShots(baseOutputPath, [], captureConfig, {
      sectionKey: "page-overview",
      sectionLabel: "Page overview",
      sectionTitle: "Page overview",
      stateLabel: "Page overview",
      label: "Page overview",
      allowGenericOverview: true
    });
    recordCaptureDiagnostic(diagnosticRun, {
      type: "related-capture",
      ok: Boolean(overview.homeOverview),
      sectionKey: "page-overview",
      sectionLabel: "Page overview",
      captureMode: "generic-page-overview",
      shotCount: 0,
      warningCount: Array.isArray(overview.warnings) ? overview.warnings.length : 0
    });
    return {
      shots: [],
      validation: relatedValidationWithOverviewWarnings(null, overview.warnings),
      trackingAudits: [],
      homeOverview: overview.homeOverview
    };
  }

  let relatedCapture;
  try {
    relatedCapture = await capturePageWithBrowserSlot(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: relatedMode,
      fullPage: false,
      lazyLoadScroll: false
    }, options);
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
      trackingAudits: [],
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
    trackingAudits: [relatedCapture.trackingAudit].filter(Boolean),
    homeOverview: overview.homeOverview,
    validation: validationWithOverview
  };
}

function emptyRelatedCapture() {
  return {
    shots: [],
    trackingAudits: [],
    homeOverview: null,
    validation: null
  };
}

async function captureFastRelatedOverview(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const overview = await composePageOverviewForRelatedShots(baseOutputPath, [], captureConfig, {
    sectionKey: "page-overview",
    sectionLabel: "Page overview",
    sectionTitle: "Page overview",
    stateLabel: "Page overview",
    label: "Page overview",
    allowGenericOverview: true
  });
  recordCaptureDiagnostic(diagnosticRun, {
    type: "related-capture",
    ok: Boolean(overview.homeOverview),
    sectionKey: "page-overview",
    sectionLabel: "Page overview",
    captureMode: "fast-related-overview",
    shotCount: 0,
    warningCount: Array.isArray(overview.warnings) ? overview.warnings.length : 0
  });
  return {
    shots: [],
    trackingAudits: [],
    homeOverview: overview.homeOverview,
    validation: relatedValidationWithOverviewWarnings(null, overview.warnings)
  };
}

function shouldSkipRelatedForFastAutomation(target, captureConfig = {}, options = {}) {
  if (!options.fastRelated || captureConfig.relatedStateFilter) {
    return false;
  }
  if (target?.id === "shokz-products-nav" || captureConfig.captureMode === "shokz-products-nav") {
    return false;
  }
  return true;
}

async function captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun, options = {}) {
  const descriptors = relatedDescriptorsForCaptureConfig([
    {
      sectionKey: "banner",
      sectionLabel: "Banner",
      captureMode: "shokz-home-banners",
      skipRelatedComposite: true,
      captureTimeoutMs: homeRelatedSectionTimeoutMs
    },
    ...shokzHomeRelatedSectionDefinitions.map((definition) => ({
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      captureMode: "shokz-home-related-section",
      sectionCaptureKey: definition.key,
      skipRelatedComposite: true,
      captureTimeoutMs: homeRelatedSectionTimeoutMs
    }))
  ], captureConfig);
  const { shots, warnings, sections, trackingAudits } = await captureIsolatedRelatedSections(
    normalizedUrl,
    baseOutputPath,
    captureConfig,
    descriptors,
    diagnosticRun,
    options
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
    trackingAudits,
    homeOverview: overview.homeOverview,
    validation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function composePageOverviewForRelatedShots(baseOutputPath, relatedShots, captureConfig, options = {}) {
  const sectionKey = options.sectionKey || "page-overview";
  const sectionLabel = options.sectionLabel || "Page overview";
  const sectionTitle = options.sectionTitle || sectionLabel;
  const stateLabel = options.stateLabel || `${sectionLabel} composite`;
  const label = options.label || stateLabel;
  const preparedShots = relatedShots
    .filter((shot) => shot?.file)
    .map((shot) => ({
      ...shot,
      outputPath: archiveAbsolutePath(shot.file)
    }));
  if (!preparedShots.length) {
    if (!options.allowGenericOverview) {
      return { homeOverview: null, warnings: [] };
    }
    try {
      const overview = await composeGenericPageOverviewCapture({
        mainOutputPath: baseOutputPath,
        outputPath: pageOverviewOutputPath(baseOutputPath, options.outputSuffix || "-page-overview-map.png"),
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
          logicalSignature: `${sectionKey}|main-page`,
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
          message: `Could not compose generic page overview screenshot: ${error.message}`
        }]
      };
    }
  }

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

async function composeGenericPageOverviewCapture({
  mainOutputPath,
  outputPath,
  viewport,
  sectionKey,
  sectionLabel,
  sectionTitle,
  stateLabel,
  label
}) {
  const mainBuffer = await fs.readFile(mainOutputPath);
  const image = decodePng(mainBuffer);
  const viewportHeight = Math.max(1, Math.min(
    image.height,
    Math.round(Number(viewport?.height || 0)) || image.height
  ));
  const positions = genericPageOverviewSlicePositions(image.height, viewportHeight);
  const gutter = 24;
  const outerPad = 24;
  const rightX = image.width + gutter;
  const width = image.width + gutter + image.width + outerPad;
  const height = Math.max(
    image.height,
    positions.reduce((max, y) => Math.max(max, y + Math.min(viewportHeight, image.height - y)), 0) + outerPad
  );
  const rgba = new Uint8Array(width * height * 4);
  fillRgba(rgba, [246, 248, 248, 255]);
  copyRgbaRect({
    source: image.rgba,
    sourceWidth: image.width,
    sourceHeight: image.height,
    sourceX: 0,
    sourceY: 0,
    width: image.width,
    height: image.height,
    target: rgba,
    targetWidth: width,
    targetHeight: height,
    x: 0,
    y: 0
  });

  const sourceFile = archiveRelativePath(mainOutputPath);
  const variants = [];
  for (const [index, y] of positions.entries()) {
    const sliceHeight = Math.max(1, Math.min(viewportHeight, image.height - y));
    const rect = {
      x: rightX,
      y,
      width: image.width,
      height: sliceHeight
    };
    copyRgbaRect({
      source: image.rgba,
      sourceWidth: image.width,
      sourceHeight: image.height,
      sourceX: 0,
      sourceY: y,
      width: image.width,
      height: sliceHeight,
      target: rgba,
      targetWidth: width,
      targetHeight: height,
      x: rect.x,
      y: rect.y
    });
    variants.push({
      key: `${sectionKey}:viewport-${index + 1}`,
      label: `Viewport ${index + 1}`,
      sectionKey,
      sectionLabel,
      rect,
      sourceClip: {
        x: 0,
        y,
        width: image.width,
        height: sliceHeight
      },
      sourceFile
    });
  }

  const buffer = encodePng(width, height, rgba);
  await fs.writeFile(outputPath, buffer);
  const visualSignature = hashBuffer(buffer);
  const visualHash = visualHashForBuffer(buffer);
  const visualAudit = visualAuditForBuffer(buffer, visualHash);

  return {
    outputPath,
    width,
    height,
    kind: "home-overview-composite",
    sectionKey,
    sectionLabel,
    sectionTitle,
    stateIndex: 1,
    stateCount: 1,
    stateLabel,
    label,
    interactionState: "default",
    logicalSignature: `${sectionKey}|main-page`,
    visualSignature,
    visualHash,
    visualAudit,
    clip: {
      x: 0,
      y: 0,
      width,
      height
    },
    scrollInfo: {
      height,
      viewportWidth: Number(viewport?.width || 0) || image.width,
      viewportHeight,
      pageCount: variants.length
    },
    composite: {
      mainWidth: image.width,
      gutter,
      outerPad,
      sectionCount: 1,
      variantCount: variants.length,
      variants
    },
    itemCount: variants.length,
    visibleItemCount: variants.length,
    visibleItems: variants,
    itemRects: variants.map((item) => ({
      key: item.key,
      label: item.label,
      rect: item.rect
    }))
  };
}

function genericPageOverviewSlicePositions(pageHeight, viewportHeight) {
  const height = Math.max(1, Math.round(Number(pageHeight) || 0));
  const sliceHeight = Math.max(1, Math.min(height, Math.round(Number(viewportHeight) || height)));
  if (height <= sliceHeight) {
    return [0];
  }
  const maxSlices = 8;
  const maxStart = height - sliceHeight;
  const step = Math.max(sliceHeight, Math.ceil(maxStart / Math.max(1, maxSlices - 1)));
  const positions = [];
  for (let y = 0; y <= maxStart; y += step) {
    positions.push(y);
  }
  positions.push(maxStart);
  return [...new Set(positions.map((y) => Math.max(0, Math.min(maxStart, Math.round(y)))))].sort((a, b) => a - b);
}

function fillRgba(rgba, color) {
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = color[0];
    rgba[index + 1] = color[1];
    rgba[index + 2] = color[2];
    rgba[index + 3] = color[3];
  }
}

function copyRgbaRect({
  source,
  sourceWidth,
  sourceHeight,
  sourceX,
  sourceY,
  width,
  height,
  target,
  targetWidth,
  targetHeight,
  x,
  y
}) {
  const safeWidth = Math.max(0, Math.min(width, sourceWidth - sourceX, targetWidth - x));
  const safeHeight = Math.max(0, Math.min(height, sourceHeight - sourceY, targetHeight - y));
  for (let row = 0; row < safeHeight; row += 1) {
    const sourceOffset = ((sourceY + row) * sourceWidth + sourceX) * 4;
    const targetOffset = ((y + row) * targetWidth + x) * 4;
    target.set(source.subarray(sourceOffset, sourceOffset + safeWidth * 4), targetOffset);
  }
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

async function captureShokzCollectionRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun, options = {}) {
  const descriptors = collectionRelatedDescriptorsForCaptureConfig(captureConfig);
  const { shots, warnings, sections, trackingAudits } = await captureIsolatedRelatedSections(
    normalizedUrl,
    baseOutputPath,
    captureConfig,
    descriptors,
    diagnosticRun,
    options
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
    trackingAudits,
    homeOverview: overview.homeOverview,
    validation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function captureShokzComparisonRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun, options = {}) {
  const descriptors = comparisonRelatedDescriptorsForCaptureConfig(captureConfig);
  const { shots, warnings, sections, trackingAudits } = await captureIsolatedRelatedSections(
    normalizedUrl,
    baseOutputPath,
    captureConfig,
    descriptors,
    diagnosticRun,
    options
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
    trackingAudits,
    homeOverview: overview.homeOverview,
    validation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function captureIsolatedRelatedSections(normalizedUrl, baseOutputPath, captureConfig, descriptors, diagnosticRun, options = {}) {
  const shots = [];
  const warnings = [];
  const sections = [];
  const trackingAudits = [];
  const queue = await runJobQueue(descriptors, (descriptor) =>
    captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun, options), {
      concurrency: relatedCaptureConcurrency(captureConfig),
      maxConcurrency: 3,
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
    trackingAudits.push(...(result.trackingAudits || []));
    warnings.push(...(result.validation?.warnings || []));
    sections.push(...(result.validation?.sections || []));
  }

  return {
    shots,
    warnings,
    sections,
    trackingAudits,
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

  if (captureConfig.relatedStateFilter) {
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
          skipRelatedComposite: true,
          captureTimeoutMs: collectionRelatedSectionTimeoutMs
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

  if (captureConfig.relatedStateFilter) {
    return descriptors;
  }
  return descriptors.flatMap((descriptor) => {
    if (descriptor.sectionKey !== "comparison-products") {
      return [descriptor];
    }
    if (!shouldCaptureDeepComparisonProducts(captureConfig)) {
      return [];
    }
    return shokzComparisonProductMapStates.length
      ? shokzComparisonProductMapStates.map((state, index) => ({
          ...descriptor,
          sectionLabel: `${descriptor.sectionLabel} / ${state.productLabel || state.productKey}`,
          relatedStateFilter: relatedFilterForComparisonProductState(descriptor.sectionKey, state, index),
          skipRelatedComposite: true,
          captureTimeoutMs: comparisonProductStateTimeoutMs
        }))
      : [{ ...descriptor, captureTimeoutMs: mobileComparisonProductMapTimeoutMs }];
  });
}

function shouldCaptureDeepComparisonProducts(captureConfig = {}) {
  const value = captureConfig.captureComparisonProducts ??
    captureConfig.deepRelatedCaptures ??
    process.env.PAGE_SHOT_DEEP_RELATED;
  return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ""));
}

function relatedFilterForCollectionState(sectionKey, state = {}) {
  return {
    sectionKey,
    categoryKey: state.categoryKey || state.matchHandle || null,
    tabLabel: state.tabLabel || state.categoryLabel || state.stateLabel || null,
    tileKey: state.categoryKey || state.fileId || state.stateLabel || null
  };
}

function relatedFilterForComparisonProductState(sectionKey, state = {}, index = 0) {
  const productKey = state.productKey || state.fileId || null;
  const productLabel = state.productLabel || state.stateLabel || productKey;
  return {
    sectionKey,
    productKey,
    productLabel,
    tabLabel: productLabel,
    tileKey: productKey || productLabel,
    stateIndex: index + 1
  };
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

async function captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun, options = {}) {
  let relatedCapture;
  try {
    relatedCapture = await capturePageWithBrowserSlot(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: descriptor.captureMode,
      sectionKey: descriptor.sectionCaptureKey || null,
      relatedStateFilter: descriptor.relatedStateFilter || captureConfig.relatedStateFilter || null,
      skipRelatedComposite: Boolean(descriptor.skipRelatedComposite || captureConfig.skipRelatedComposite),
      captureTimeoutMs: descriptor.captureTimeoutMs || captureConfig.captureTimeoutMs,
      fullPage: false,
      lazyLoadScroll: false
    }, options);
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
      trackingAudits: [],
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
  return { shots, trackingAudits: [relatedCapture.trackingAudit].filter(Boolean), validation };
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
  collectionRelatedDescriptorsForCaptureConfig,
  comparisonRelatedDescriptorsForCaptureConfig,
  relatedCaptureModeForTarget,
  shouldSkipRelatedForFastAutomation,
  relatedCaptureConcurrency,
  captureBrowserConcurrency,
  captureRetryAttempts,
  runCaptureNetworkPreflight,
  skipCaptureRunForNetworkPreflight,
  shouldRetryCaptureResult,
  resolveAdHocCaptureExecution,
  createCaptureRunRecord,
  captureConcurrency,
  composeGenericPageOverviewCapture,
  genericPageOverviewSlicePositions,
  runnerNameForPlatform
};

function runnerNameForPlatform(platform) {
  return platform === "mobile" ? "captureMobilePlan" : "capturePcPlan";
}
