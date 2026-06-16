import fs from "node:fs/promises";
import path from "node:path";
import { logsDir } from "../paths.js";

const statusLabels = Object.freeze({
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped"
});

export function workflowTaskPaths(runId, options = {}) {
  const baseLogsDir = options.logsDir || logsDir;
  const safeRunId = safeFilePart(runId || "workflow-run");
  return {
    runFilePath: options.runFilePath || path.join(baseLogsDir, "workflow-runs", `${safeRunId}.json`),
    checklistFilePath: options.checklistFilePath || path.join(baseLogsDir, "workflow-checklists", `${safeRunId}.md`)
  };
}

export function createWorkflowRun({ id, type, title, tasks = [], startedAt = new Date().toISOString() } = {}) {
  const normalizedTasks = tasks.map(normalizeTask);
  return finalizeWorkflowRun({
    id: id || `workflow-${startedAt.replace(/[:.]/g, "-")}`,
    type: type || "workflow",
    title: title || "Workflow run",
    status: "running",
    startedAt,
    finishedAt: null,
    tasks: normalizedTasks
  });
}

export function workflowTasksFromCaptureResults(results = []) {
  return (Array.isArray(results) ? results : []).map((result, index) => ({
    ...captureTaskFromResult(result, index)
  }));
}

export function workflowTasksFromCompareResult(result = {}) {
  const changes = Array.isArray(result.changes) ? result.changes : [];
  if (result.error) {
    return [{
      id: "compare-error",
      label: "Compare",
      module: "compare",
      status: "failed",
      checked: false,
      error: result.error
    }];
  }
  if (result.skippedReason) {
    return [{
      id: "compare-skipped",
      label: "Compare",
      module: "compare",
      status: "skipped",
      checked: false,
      message: result.skippedReason
    }];
  }
  if (!changes.length) {
    const snapshotCount = Array.isArray(result.snapshotIds) ? result.snapshotIds.length : 0;
    return [{
      id: "compare-no-change",
      label: "Compare",
      module: "compare",
      status: "completed",
      checked: true,
      message: snapshotCount > 0
        ? `Compared ${snapshotCount} snapshots; no recordable changes`
        : "No recordable changes"
    }];
  }
  return changes.map((change, index) => ({
    id: change.id || `compare-change-${index + 1}`,
    label: change.location?.displayUrl || change.location?.targetLabel || change.location?.url || `Change ${index + 1}`,
    module: "compare",
    platform: change.location?.platform || "",
    targetId: change.location?.targetId || "",
    capturePlanId: change.location?.capturePlanId || "",
    status: "completed",
    checked: true,
    recordId: change.id || null,
    message: change.changeLevel ? `${change.changeLevel} ${change.changeType || "change"}` : "Compare completed"
  }));
}

export async function saveWorkflowRun(run, options = {}) {
  const finalized = finalizeWorkflowRun(run);
  const paths = workflowTaskPaths(finalized.id, options);
  await fs.mkdir(path.dirname(paths.runFilePath), { recursive: true });
  await fs.mkdir(path.dirname(paths.checklistFilePath), { recursive: true });
  await fs.writeFile(paths.runFilePath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  await fs.writeFile(paths.checklistFilePath, renderWorkflowChecklistMarkdown(finalized), "utf8");
  return { run: finalized, paths };
}

export async function loadWorkflowRun(runId, options = {}) {
  const paths = workflowTaskPaths(runId, options);
  try {
    const parsed = JSON.parse(await fs.readFile(paths.runFilePath, "utf8"));
    return parsed && typeof parsed === "object" && Array.isArray(parsed.tasks) ? parsed : null;
  } catch {
    return null;
  }
}

export function renderWorkflowChecklistMarkdown(run) {
  const finalized = finalizeWorkflowRun(run);
  const lines = [
    `# ${finalized.title}`,
    "",
    `- Run ID: ${finalized.id}`,
    `- Type: ${finalized.type}`,
    `- Status: ${finalized.status}`,
    `- Total tasks: ${finalized.totalCount}`,
    `- Completed: ${finalized.completedCount}`,
    `- Failed: ${finalized.failedCount}`,
    `- Skipped: ${finalized.skippedCount}`,
    ""
  ];
  for (const task of finalized.tasks) {
    const checkbox = task.checked ? "x" : " ";
    const platform = task.platform ? ` / ${task.platform === "mobile" ? "Mobile" : "PC"}` : "";
    lines.push(`- [${checkbox}] ${task.label}${platform}`);
    lines.push(`  - Status: ${statusLabels[task.status] || task.status}`);
    if (task.message) {
      lines.push(`  - Note: ${task.message}`);
    }
    if (task.error) {
      lines.push(`  - Reason: ${task.error}`);
    }
    if (task.recordId) {
      lines.push(`  - Record: ${task.recordId}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function finalizeWorkflowRun(run = {}) {
  const tasks = (Array.isArray(run.tasks) ? run.tasks : []).map(normalizeTask);
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const skippedCount = tasks.filter((task) => task.status === "skipped").length;
  return {
    ...run,
    tasks,
    totalCount: tasks.length,
    completedCount,
    failedCount,
    skippedCount,
    status: run.status && run.status !== "running"
      ? run.status
      : failedCount > 0
        ? completedCount > 0 ? "partial" : "failed"
        : skippedCount > 0 && skippedCount === tasks.length
          ? "skipped"
          : "succeeded"
  };
}

function normalizeTask(input = {}) {
  const status = normalizeStatus(input.status);
  return {
    id: cleanText(input.id) || `task-${Math.random().toString(36).slice(2, 8)}`,
    label: cleanText(input.label) || cleanText(input.targetLabel) || cleanText(input.targetId) || "Task",
    module: cleanText(input.module) || "workflow",
    platform: cleanText(input.platform),
    targetId: cleanText(input.targetId),
    capturePlanId: cleanText(input.capturePlanId),
    status,
    checked: input.checked ?? status === "completed",
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null,
    recordId: cleanText(input.recordId) || null,
    message: cleanText(input.message) || null,
    error: cleanText(input.error) || null
  };
}

function captureTaskFromResult(result = {}, index = 0) {
  const issues = captureSelfCheckIssues(result);
  const failed = !result.ok || issues.length > 0;
  return {
    id: result.runItemId || `${result.capturePlanId || "capture"}-${index + 1}`,
    label: result.displayUrl || result.targetLabel || result.url || result.capturePlanId || `Capture ${index + 1}`,
    module: "capture",
    platform: result.platform || "",
    targetId: result.targetId || "",
    capturePlanId: result.capturePlanId || "",
    status: result.skipped ? "skipped" : failed ? "failed" : "completed",
    checked: Boolean(result.ok && !issues.length),
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || null,
    recordId: captureResultSnapshotIds(result).join(", "),
    message: result.ok && !issues.length ? "Capture completed; self-check passed" : null,
    error: result.skipped ? null : result.error || issues.join("; ") || null
  };
}

function captureSelfCheckIssues(result = {}) {
  if (!result.ok) {
    return [];
  }
  const snapshots = captureResultSnapshots(result);
  if (!snapshots.length) {
    return ["No screenshot record was created"];
  }
  const issues = [];
  for (const snapshot of snapshots) {
    if (!snapshot.file || !snapshot.imageUrl) {
      issues.push("Screenshot is missing file link");
    }
    if (Number(snapshot.width || 0) <= 0 || Number(snapshot.height || 0) <= 0) {
      issues.push("Screenshot dimensions are invalid");
    }
    if (snapshot.truncated) {
      issues.push("Screenshot was truncated");
    }
    if (snapshot.captureConfidence?.baselineEligible === false) {
      issues.push(`Screenshot confidence is low: ${(snapshot.captureConfidence.reasons || []).join(", ") || "unknown"}`);
    }
  }
  return [...new Set(issues)];
}

function normalizeStatus(value) {
  const status = cleanText(value);
  return Object.hasOwn(statusLabels, status) ? status : "pending";
}

function captureResultSnapshotIds(result = {}) {
  return captureResultSnapshots(result).map((snapshot) => snapshot?.id).filter(Boolean);
}

function captureResultSnapshots(result = {}) {
  if (Array.isArray(result.snapshots) && result.snapshots.length) {
    return result.snapshots;
  }
  return result.snapshot ? [result.snapshot] : [];
}

function safeFilePart(value) {
  return cleanText(value).replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "workflow-run";
}

function cleanText(value) {
  return String(value || "").trim();
}
