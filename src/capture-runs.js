import fs from "node:fs/promises";
import path from "node:path";
import { captureRunsPath } from "./paths.js";

const maxStoredRuns = 200;

export async function loadCaptureRuns(filePath = captureRunsPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(parsed)
      ? parsed.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      : [];
  } catch {
    return [];
  }
}

export async function appendCaptureRun(run, options = {}) {
  const filePath = options.filePath || captureRunsPath;
  const limit = clampInteger(options.limit, 1, 2000, maxStoredRuns);
  const runs = await loadCaptureRuns(filePath);
  const nextRuns = [
    normalizeCaptureRun(run),
    ...runs.filter((entry) => entry?.id !== run?.id)
  ].slice(0, limit);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(nextRuns, null, 2)}\n`, "utf8");
  return nextRuns[0];
}

function normalizeCaptureRun(run = {}) {
  const items = Array.isArray(run.items) ? run.items : [];
  return {
    id: stringOrDefault(run.id, `run-${Date.now()}`),
    status: stringOrDefault(run.status, "unknown"),
    startedAt: stringOrNull(run.startedAt),
    finishedAt: stringOrNull(run.finishedAt),
    durationMs: numberOrNull(run.durationMs),
    totalCount: numberOrDefault(run.totalCount, items.length),
    successCount: numberOrDefault(run.successCount, items.filter((item) => item?.ok).length),
    failureCount: numberOrDefault(run.failureCount, items.filter((item) => item?.ok === false).length),
    skippedCount: numberOrDefault(run.skippedCount, 0),
    concurrency: numberOrDefault(run.concurrency, 1),
    jobQueue: normalizeCaptureRunJobQueue(run.jobQueue),
    changeRefresh: run.changeRefresh || null,
    seoRefresh: run.seoRefresh || null,
    textQualityRefresh: run.textQualityRefresh || null,
    networkPreflight: run.networkPreflight || null,
    items: items.map(normalizeCaptureRunItem)
  };
}

function normalizeCaptureRunJobQueue(jobQueue = null) {
  if (!jobQueue || typeof jobQueue !== "object") {
    return null;
  }
  return {
    totalCount: numberOrDefault(jobQueue.totalCount, 0),
    concurrency: numberOrDefault(jobQueue.concurrency, 1),
    durationMs: numberOrNull(jobQueue.durationMs),
    maxActiveCount: numberOrNull(jobQueue.maxActiveCount)
  };
}

function normalizeCaptureRunItem(item = {}) {
  return {
    id: stringOrDefault(item.id, item.capturePlanId || "capture-item"),
    status: stringOrDefault(item.status, item.ok === false ? "failed" : "unknown"),
    ok: item.ok === undefined || item.ok === null ? null : Boolean(item.ok),
    targetId: stringOrNull(item.targetId),
    targetLabel: stringOrNull(item.targetLabel),
    url: stringOrNull(item.url || item.requestedUrl),
    platform: stringOrNull(item.platform),
    deviceProfileId: stringOrNull(item.deviceProfileId),
    devicePresetId: stringOrNull(item.devicePresetId),
    capturePlanId: stringOrNull(item.capturePlanId),
    startedAt: stringOrNull(item.startedAt),
    finishedAt: stringOrNull(item.finishedAt),
    durationMs: numberOrNull(item.durationMs),
    retryCount: numberOrDefault(item.retryCount, 0),
    snapshotIds: Array.isArray(item.snapshotIds) ? item.snapshotIds.filter(Boolean) : [],
    error: stringOrNull(item.error)
  };
}

function stringOrDefault(value, fallback) {
  const text = stringOrNull(value);
  return text || fallback;
}

function stringOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
