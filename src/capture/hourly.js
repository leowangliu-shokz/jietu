import { fileURLToPath } from "node:url";
import { captureConfiguredUrls } from "../capture-service.js";
import { loadConfig } from "../store.js";

export async function runHourlyCapture(options = {}) {
  const config = options.config || await loadConfig();
  const results = await captureConfiguredUrls(config, {
    ...options,
    deferChangeRefresh: true
  });
  return {
    ok: !results.some((result) => result && !result.ok && !result.skipped),
    results,
    run: results.captureRun || null
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runHourlyCapture({
    platform: readArg("--platform") || undefined
  });
  const run = result.run;
  const succeeded = run?.successCount ?? result.results.filter((item) => item?.ok).length;
  const failed = run?.failureCount ?? result.results.filter((item) => item && !item.ok && !item.skipped).length;
  console.log(`Hourly capture ${result.ok ? "succeeded" : "failed"}: ${succeeded} succeeded, ${failed} failed.`);
  if (run?.id) {
    console.log(`Run: ${run.id}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}
