import fs from "node:fs/promises";
import path from "node:path";
import { logsDir } from "../paths.js";
import { resolveConfiguredCapturePlans } from "../store.js";

export const auditModules = Object.freeze(["seo", "woodpecker", "tracking"]);

const moduleLabels = Object.freeze({
  seo: "SEO 检查",
  woodpecker: "啄木鸟检查",
  tracking: "埋点审计"
});

const statusLabels = Object.freeze({
  pending: "待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  skipped: "跳过"
});

export function auditChecklistPaths(date = todayIsoDate(), options = {}) {
  const baseLogsDir = options.logsDir || logsDir;
  return {
    runFilePath: options.runFilePath || path.join(baseLogsDir, "audit-runs", `${date}.json`),
    checklistFilePath: options.checklistFilePath || path.join(baseLogsDir, "audit-checklists", `${date}.md`)
  };
}

export function createAuditRun(config, options = {}) {
  const date = options.date || todayIsoDate();
  const modules = normalizeModules(options.modules);
  const tasks = buildAuditTasks(config, { date, modules });
  const startedAt = options.startedAt || new Date().toISOString();
  return {
    id: options.id || `audit-${date}`,
    date,
    status: "running",
    startedAt,
    finishedAt: null,
    totalCount: tasks.length,
    completedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    modules,
    tasks
  };
}

export function buildAuditTasks(config, options = {}) {
  const date = options.date || todayIsoDate();
  const modules = normalizeModules(options.modules);
  const plans = resolveConfiguredCapturePlans(config);
  const tasks = [];

  for (const moduleName of modules) {
    for (const plan of plans) {
      const target = plan.target || {};
      const deviceProfile = plan.deviceProfile || {};
      const platform = plan.platform || deviceProfile.platform || "";
      const targetId = plan.targetId || target.id || "";
      const deviceProfileId = plan.deviceProfileId || deviceProfile.id || "";
      tasks.push({
        id: auditTaskId({ date, moduleName, targetId, deviceProfileId }),
        date,
        module: moduleName,
        moduleLabel: moduleLabels[moduleName] || moduleName,
        targetId,
        targetLabel: target.label || target.url || targetId,
        url: target.url || "",
        platform,
        deviceProfileId,
        devicePresetId: plan.devicePreset?.id || deviceProfile.devicePresetId || "",
        capturePlanId: plan.id || "",
        status: "pending",
        checked: false,
        startedAt: null,
        finishedAt: null,
        recordId: null,
        message: null,
        error: null
      });
    }
  }

  return tasks;
}

export function markModuleRunning(run, moduleName, now = new Date().toISOString()) {
  return updateRunTasks(run, (task) => {
    if (task.module !== moduleName || task.status !== "pending") {
      return task;
    }
    return {
      ...task,
      status: "running",
      startedAt: task.startedAt || now
    };
  });
}

export function completeModuleTasks(run, moduleName, records = [], options = {}) {
  const now = options.finishedAt || new Date().toISOString();
  return updateRunTasks(run, (task) => {
    if (task.module !== moduleName) {
      return task;
    }
    if (task.status === "completed" && options.preserveCompleted !== false) {
      return task;
    }
    const record = findRecordForTask(records, task);
    if (record) {
      return {
        ...task,
        status: "completed",
        checked: true,
        finishedAt: now,
        recordId: record.id || record.snapshotId || null,
        message: options.successMessage || "检查完成",
        error: null
      };
    }
    return {
      ...task,
      status: "failed",
      checked: false,
      finishedAt: now,
      message: null,
      error: options.missingRecordMessage || "未找到该页面/设备的检查记录"
    };
  });
}

export function failModuleTasks(run, moduleName, error, options = {}) {
  const now = options.finishedAt || new Date().toISOString();
  const message = error?.message || String(error || "检查失败");
  return updateRunTasks(run, (task) => {
    if (task.module !== moduleName) {
      return task;
    }
    return {
      ...task,
      status: "failed",
      checked: false,
      finishedAt: now,
      error: message
    };
  });
}

export function finalizeAuditRun(run, finishedAt = new Date().toISOString()) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const skippedCount = tasks.filter((task) => task.status === "skipped").length;
  return {
    ...run,
    status: failedCount > 0
      ? completedCount > 0 ? "partial" : "failed"
      : "succeeded",
    finishedAt,
    totalCount: tasks.length,
    completedCount,
    failedCount,
    skippedCount
  };
}

export async function saveAuditRun(run, options = {}) {
  const paths = auditChecklistPaths(run.date, options);
  await fs.mkdir(path.dirname(paths.runFilePath), { recursive: true });
  await fs.mkdir(path.dirname(paths.checklistFilePath), { recursive: true });
  await fs.writeFile(paths.runFilePath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await fs.writeFile(paths.checklistFilePath, renderAuditChecklistMarkdown(run), "utf8");
  return paths;
}

export async function loadAuditRun(date = todayIsoDate(), options = {}) {
  const paths = auditChecklistPaths(date, options);
  try {
    const parsed = JSON.parse(await fs.readFile(paths.runFilePath, "utf8"));
    return parsed && typeof parsed === "object" && Array.isArray(parsed.tasks) ? parsed : null;
  } catch {
    return null;
  }
}

export function mergeAuditRunProgress(nextRun, previousRun) {
  if (!previousRun?.tasks?.length) {
    return nextRun;
  }
  const previousById = new Map(previousRun.tasks.map((task) => [task.id, task]));
  const tasks = nextRun.tasks.map((task) => {
    const previous = previousById.get(task.id);
    if (!previous || previous.status !== "completed") {
      return task;
    }
    return {
      ...task,
      status: "completed",
      checked: true,
      startedAt: previous.startedAt || task.startedAt,
      finishedAt: previous.finishedAt || task.finishedAt,
      recordId: previous.recordId || task.recordId,
      message: previous.message || task.message,
      error: null
    };
  });
  return finalizeCounts({
    ...nextRun,
    startedAt: previousRun.startedAt || nextRun.startedAt,
    tasks
  });
}

export function moduleIsComplete(run, moduleName) {
  const tasks = (Array.isArray(run?.tasks) ? run.tasks : []).filter((task) => task.module === moduleName);
  return tasks.length > 0 && tasks.every((task) => task.status === "completed");
}

export function renderAuditChecklistMarkdown(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const lines = [
    `# ${run.date} 自动巡检任务清单`,
    "",
    `- 状态：${run.status || "running"}`,
    `- 总任务：${tasks.length}`,
    `- 已完成：${tasks.filter((task) => task.status === "completed").length}`,
    `- 失败：${tasks.filter((task) => task.status === "failed").length}`,
    `- 跳过：${tasks.filter((task) => task.status === "skipped").length}`,
    ""
  ];

  for (const moduleName of normalizeModules(run.modules)) {
    const moduleTasks = tasks.filter((task) => task.module === moduleName);
    lines.push(`## ${moduleLabels[moduleName] || moduleName}`);
    if (!moduleTasks.length) {
      lines.push("", "- 暂无任务", "");
      continue;
    }
    for (const task of moduleTasks) {
      const checkbox = task.checked ? "x" : " ";
      const label = `${task.targetLabel || task.targetId} / ${platformLabel(task.platform)}`;
      lines.push(`- [${checkbox}] ${label}`);
      lines.push(`  - 状态：${statusLabels[task.status] || task.status}`);
      if (task.error) {
        lines.push(`  - 原因：${task.error}`);
      }
      if (task.recordId) {
        lines.push(`  - 记录：${task.recordId}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function updateRunTasks(run, updater) {
  const next = {
    ...run,
    tasks: (Array.isArray(run?.tasks) ? run.tasks : []).map(updater)
  };
  return finalizeCounts(next);
}

function finalizeCounts(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  return {
    ...run,
    totalCount: tasks.length,
    completedCount: tasks.filter((task) => task.status === "completed").length,
    failedCount: tasks.filter((task) => task.status === "failed").length,
    skippedCount: tasks.filter((task) => task.status === "skipped").length
  };
}

function findRecordForTask(records, task) {
  return (Array.isArray(records) ? records : []).find((record) => recordMatchesTask(record, task)) || null;
}

function recordMatchesTask(record, task) {
  if (!record || !task) {
    return false;
  }
  if (task.capturePlanId && cleanText(record.capturePlanId) === task.capturePlanId) {
    return true;
  }
  return cleanText(record.targetId) === task.targetId &&
    cleanText(record.deviceProfileId) === task.deviceProfileId &&
    cleanText(record.platform || "pc") === cleanText(task.platform || "pc");
}

function auditTaskId({ date, moduleName, targetId, deviceProfileId }) {
  return [date, moduleName, targetId, deviceProfileId]
    .map((part) => cleanText(part).replace(/[^a-z0-9_-]+/gi, "-"))
    .join("::");
}

function normalizeModules(modules) {
  const requested = Array.isArray(modules) && modules.length ? modules : auditModules;
  const allowed = new Set(auditModules);
  return requested
    .map((moduleName) => cleanText(moduleName))
    .filter((moduleName, index, list) => allowed.has(moduleName) && list.indexOf(moduleName) === index);
}

function platformLabel(platform) {
  return cleanText(platform) === "mobile" ? "Mobile" : "PC";
}

function cleanText(value) {
  return String(value || "").trim();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
