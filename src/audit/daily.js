import {
  completeModuleTasks,
  createAuditRun,
  failModuleTasks,
  loadAuditRun,
  markModuleRunning,
  mergeAuditRunProgress,
  moduleIsComplete,
  saveAuditRun
} from "../jobs/audit-checklist.js";
import { fileURLToPath } from "node:url";
import { loadSeoSnapshots, rebuildSeoChanges } from "../seo-snapshots.js";
import { loadConfig } from "../store.js";
import { rebuildTextQuality } from "../text-quality.js";
import { loadTrackingAuditRecords } from "../tracking-audit.js";

export async function runDailyAudit(options = {}) {
  const config = options.config || await loadConfig();
  let run = createAuditRun(config, {
    date: options.date,
    modules: options.modules
  });
  const outputOptions = {
    logsDir: options.logsDir,
    runFilePath: options.runFilePath,
    checklistFilePath: options.checklistFilePath
  };
  if (options.resume !== false && !options.force) {
    run = mergeAuditRunProgress(run, await loadAuditRun(run.date, outputOptions));
  }

  await saveAuditRun(run, outputOptions);

  for (const moduleName of run.modules) {
    if (!options.force && moduleIsComplete(run, moduleName)) {
      continue;
    }
    run = markModuleRunning(run, moduleName);
    await saveAuditRun(run, outputOptions);
    try {
      const records = await runAuditModule(moduleName, options);
      run = completeModuleTasks(run, moduleName, records, {
        successMessage: "检查完成",
        missingRecordMessage: missingRecordMessageForModule(moduleName)
      });
    } catch (error) {
      run = failModuleTasks(run, moduleName, error);
    }
    await saveAuditRun(run, outputOptions);
  }

  run = {
    ...run,
    finishedAt: new Date().toISOString(),
    status: run.failedCount > 0
      ? run.completedCount > 0 ? "partial" : "failed"
      : "succeeded"
  };
  await saveAuditRun(run, outputOptions);
  return run;
}

async function runAuditModule(moduleName, options = {}) {
  if (moduleName === "seo") {
    await rebuildSeoChanges({
      seoSnapshotsFilePath: options.seoSnapshotsFilePath,
      seoChangesFilePath: options.seoChangesFilePath
    });
    return loadSeoSnapshots(options.seoSnapshotsFilePath);
  }

  if (moduleName === "woodpecker") {
    return rebuildTextQuality({
      latestOnly: true,
      textQualityFilePath: options.textQualityFilePath,
      snapshots: options.snapshots,
      htmlFetchCache: options.htmlFetchCache,
      fetchHtmlAttributes: options.fetchHtmlAttributes
    });
  }

  if (moduleName === "tracking") {
    return loadTrackingAuditRecords(options.trackingAuditFilePath);
  }

  throw new Error(`Unsupported audit module: ${moduleName}`);
}

function missingRecordMessageForModule(moduleName) {
  if (moduleName === "seo") {
    return "未找到该页面/设备的 SEO 快照，请先完成截图或补跑 SEO 采集。";
  }
  if (moduleName === "woodpecker") {
    return "未生成该页面/设备的啄木鸟记录。";
  }
  if (moduleName === "tracking") {
    return "未找到该页面/设备的埋点审计记录，请先完成带埋点采集的截图。";
  }
  return "未找到该页面/设备的检查记录。";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dateArg = readArg("--date");
  const moduleArg = readArg("--module");
  const modules = moduleArg
    ? moduleArg.split(",").map((value) => value.trim()).filter(Boolean)
    : undefined;
  const run = await runDailyAudit({
    date: dateArg,
    modules,
    force: process.argv.includes("--force")
  });
  console.log(`Daily audit ${run.status}: ${run.completedCount}/${run.totalCount} completed, ${run.failedCount} failed.`);
  console.log(`Checklist: logs/audit-checklists/${run.date}.md`);
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}
