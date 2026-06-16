import { fileURLToPath } from "node:url";
import { runDailyAudit } from "../audit/daily.js";
import { runHourlyCapture } from "../capture/hourly.js";
import { runCompareWorker } from "../compare/worker.js";

const defaultHourlyIntervalMs = 60 * 60 * 1000;

export async function runScheduledCycle(options = {}) {
  const capture = await runHourlyCapture(options.capture || {});
  const compare = await runCompareWorker(options.compare || {});
  let audit = null;
  if (options.runDailyAudit) {
    audit = await runDailyAudit(options.audit || {});
  }
  return {
    ok: Boolean(capture.ok && compare.ok && (!audit || audit.status === "succeeded" || audit.status === "partial")),
    capture,
    compare,
    audit
  };
}

export async function startLocalScheduler(options = {}) {
  const intervalMs = Number(options.intervalMs || process.env.PAGE_SHOT_HOURLY_INTERVAL_MS || defaultHourlyIntervalMs);
  const runImmediately = options.runImmediately !== false;
  let running = false;
  let lastDailyAuditDate = options.lastDailyAuditDate || null;

  async function runCycle() {
    if (running) {
      console.log("Scheduled cycle skipped because a previous cycle is still running.");
      return;
    }
    running = true;
    const runDailyAuditNow = shouldRunDailyAudit(options, lastDailyAuditDate);
    try {
      const result = await runScheduledCycle({
        runDailyAudit: runDailyAuditNow,
        capture: options.capture,
        compare: options.compare,
        audit: options.audit
      });
      if (runDailyAuditNow) {
        lastDailyAuditDate = todayLocalDate();
      }
      console.log(`Scheduled cycle ${result.ok ? "completed" : "completed with failures"}.`);
    } catch (error) {
      console.error(`Scheduled cycle failed: ${error.message}`);
    } finally {
      running = false;
    }
  }

  if (runImmediately) {
    await runCycle();
  }
  const timer = setInterval(runCycle, Math.max(60 * 1000, intervalMs));
  return {
    stop() {
      clearInterval(timer);
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const once = process.argv.includes("--once");
  const runDaily = process.argv.includes("--daily");
  if (once) {
    const result = await runScheduledCycle({ runDailyAudit: runDaily });
    console.log(`One-shot scheduled cycle ${result.ok ? "completed" : "completed with failures"}.`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } else {
    console.log("Local scheduler started. Press Ctrl+C to stop.");
    await startLocalScheduler({ runImmediately: !process.argv.includes("--no-immediate") });
  }
}

function shouldRunDailyAudit(options = {}, lastDailyAuditDate = null) {
  if (options.runDailyAudit === true) {
    return true;
  }
  const hour = Number(process.env.PAGE_SHOT_DAILY_AUDIT_HOUR || 6);
  const now = new Date();
  return now.getHours() === hour && todayLocalDate(now) !== lastDailyAuditDate;
}

function todayLocalDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
