import { fileURLToPath } from "node:url";
import { loadChanges, rebuildChanges, rebuildChangesForNewSnapshots } from "../changes.js";
import { notifyChangeRecords } from "../change-notifier.js";
import { loadCaptureRuns } from "../capture-runs.js";
import { createWorkflowRun, saveWorkflowRun, workflowTasksFromCompareResult } from "../jobs/workflow-tasks.js";
import { readSnapshots } from "../store.js";
import { applitoolsConfigFromEnv } from "../vision/applitools.js";

export async function runCompareWorker(options = {}) {
  const previousChanges = await loadChanges(options.changesFilePath);
  const compareResult = await buildWorkerChanges({ ...options, previousChanges });
  const changes = compareResult.changes;
  const notification = await notifyChangeRecords(changes, {
    ...(options.notification || {}),
    previousChanges,
    sendNotifications: options.sendNotifications === true
  }).catch((error) => ({
    ok: false,
    enabled: true,
    error: error.message
  }));
  const workflow = await saveWorkflowRun(createWorkflowRun({
    id: options.workflowRunId || `compare-${compareResult.captureRun?.id || new Date().toISOString().replace(/[:.]/g, "-")}`,
    type: "compare",
    title: "Async compare task checklist",
    tasks: workflowTasksFromCompareResult({
      changes,
      snapshotIds: compareResult.snapshotIds,
      skippedReason: compareResult.skippedReason,
      error: compareResult.error
    })
  }), options.workflow || {});
  return {
    ok: true,
    mode: compareResult.mode,
    captureRunId: compareResult.captureRun?.id || null,
    snapshotCount: compareResult.snapshotIds.length,
    count: changes.length,
    changes,
    notification,
    workflowRun: workflow.run,
    workflowChecklist: workflow.paths.checklistFilePath
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runCompareWorker(parseCliArgs(process.argv.slice(2)));
  const scope = result.mode === "all"
    ? "all snapshots"
    : `${result.snapshotCount} snapshots from ${result.captureRunId || "latest capture run"}`;
  console.log(`Compare worker saved ${result.count} change records to data/changes.json (${scope})`);
  if (result.notification?.enabled || result.notification?.recordOnly) {
    const status = result.notification.ok
      ? result.notification.recordOnly
        ? `recorded ${result.notification.recordedCount || 0} without sending`
        : `sent ${result.notification.sentCount || 0}`
      : `failed: ${result.notification.error || result.notification.reason || "unknown error"}`;
    console.log(`Change notification ${status}`);
  }
  if (result.workflowChecklist) {
    console.log(`Checklist: ${result.workflowChecklist}`);
  }
}

async function buildWorkerChanges(options = {}) {
  const externalVision = options.externalVision ?? externalVisionConfigFromEnv();
  if (options.all === true) {
    const changes = await rebuildChanges({ ...options, externalVision });
    return {
      mode: "all",
      changes,
      captureRun: null,
      snapshotIds: [],
      skippedReason: null,
      error: null
    };
  }

  const captureRun = await resolveCaptureRun(options);
  if (!captureRun) {
    return {
      mode: "incremental",
      changes: options.previousChanges,
      captureRun: null,
      snapshotIds: [],
      skippedReason: "No capture run found",
      error: null
    };
  }

  const snapshotIds = snapshotIdsForCaptureRun(captureRun);
  if (!snapshotIds.length) {
    return {
      mode: "incremental",
      changes: options.previousChanges,
      captureRun,
      snapshotIds,
      skippedReason: "Capture run has no snapshot ids",
      error: null
    };
  }

  const snapshots = await readSnapshots(options.snapshotsFilePath);
  const newSnapshots = snapshotsForIds(snapshots, snapshotIds);
  if (!newSnapshots.length) {
    return {
      mode: "incremental",
      changes: options.previousChanges,
      captureRun,
      snapshotIds,
      skippedReason: "Snapshot records were not found for this capture run",
      error: null
    };
  }

  const changes = await rebuildChangesForNewSnapshots(newSnapshots, {
    ...options,
    snapshots,
    previousChanges: options.previousChanges,
    externalVision
  });
  return {
    mode: "incremental",
    changes,
    captureRun,
    snapshotIds,
    skippedReason: null,
    error: null
  };
}

async function resolveCaptureRun(options = {}) {
  const runs = await loadCaptureRuns(options.captureRunsFilePath);
  const requestedId = stringOrNull(options.captureRunId || options.sourceRunId);
  if (requestedId) {
    return runs.find((run) => run?.id === requestedId) || null;
  }
  return latestRunWithSnapshots(runs);
}

function latestRunWithSnapshots(runs = []) {
  return (Array.isArray(runs) ? runs : []).find((run) => snapshotIdsForCaptureRun(run).length > 0) || null;
}

function snapshotIdsForCaptureRun(run = {}) {
  const ids = [];
  for (const item of Array.isArray(run.items) ? run.items : []) {
    for (const id of Array.isArray(item?.snapshotIds) ? item.snapshotIds : []) {
      const cleanId = stringOrNull(id);
      if (cleanId && !ids.includes(cleanId)) {
        ids.push(cleanId);
      }
    }
  }
  return ids;
}

function snapshotsForIds(snapshots = [], snapshotIds = []) {
  const wanted = new Set(snapshotIds);
  return (Array.isArray(snapshots) ? snapshots : []).filter((snapshot) => wanted.has(snapshot?.id));
}

function parseCliArgs(args = []) {
  const options = {
    all: args.includes("--all"),
    sendNotifications: args.includes("--notify")
  };
  const runIdIndex = args.indexOf("--run-id");
  if (runIdIndex >= 0 && args[runIdIndex + 1]) {
    options.captureRunId = args[runIdIndex + 1];
  }
  return options;
}

function externalVisionConfigFromEnv() {
  const applitools = applitoolsConfigFromEnv();
  if (applitools) {
    return applitools;
  }
  const endpoint = String(process.env.VISION_COMPARE_ENDPOINT || "").trim();
  if (!endpoint) {
    return null;
  }
  return {
    endpoint,
    apiKey: String(process.env.VISION_COMPARE_API_KEY || "").trim(),
    baseUrl: String(process.env.VISION_COMPARE_BASE_URL || "").trim(),
    timeoutMs: Number(process.env.VISION_COMPARE_TIMEOUT_MS || 30000)
  };
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export const __testOnly = {
  latestRunWithSnapshots,
  snapshotIdsForCaptureRun,
  snapshotsForIds,
  parseCliArgs
};
