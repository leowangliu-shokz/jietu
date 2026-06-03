import { captureConfiguredUrls, captureOne } from "./capture-service.js";
import { loadConfig } from "./store.js";

const argUrl = process.argv[2];
const config = await loadConfig();
const results = await runCaptureCommand();

for (const result of results) {
  if (result.skipped) {
    console.log(`Skipped ${result.displayUrl || result.url || result.capturePlanId || "capture"}: ${result.error || "capture skipped"}`);
  } else if (result.ok) {
    for (const snapshot of result.snapshots || [result.snapshot]) {
      console.log(`Saved ${snapshot.displayUrl || snapshot.url} -> archive/${snapshot.file}`);
    }
  } else {
    console.error(`Failed ${result.displayUrl || result.url}: ${result.error}`);
  }
}

if (results.some((result) => !result.ok && !result.skipped)) {
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);

async function runCaptureCommand() {
  try {
    return argUrl ? [await captureOne(argUrl, config)] : await captureConfiguredUrls(config);
  } catch (error) {
    if (error.code === "CAPTURE_LOCKED") {
      console.log(error.message);
      process.exit(0);
    }
    throw error;
  }
}
