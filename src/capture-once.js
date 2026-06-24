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
    const deferChangeRefresh = process.env.PAGE_SHOT_SYNC_REFRESH !== "1";
    const screenshotOnly = process.env.PAGE_SHOT_SCREENSHOT_ONLY !== "0";
    const captureOptions = {
      deferChangeRefresh,
      screenshotOnly,
      fastCaptureOnly: process.env.PAGE_SHOT_FAST_CAPTURE_ONLY === "1",
      fastFullPage: process.env.PAGE_SHOT_FAST_FULLPAGE === "1",
      playwrightFullPage: process.env.PAGE_SHOT_PLAYWRIGHT_FULLPAGE !== "0",
      playwrightFullPageTimeoutMs: Number(process.env.PAGE_SHOT_PLAYWRIGHT_FULLPAGE_TIMEOUT_MS) || undefined,
      fastFullPageTimeoutMs: Number(process.env.PAGE_SHOT_FAST_FULLPAGE_TIMEOUT_MS) || undefined,
      fastFullPageAttemptTimeoutMs: Number(process.env.PAGE_SHOT_FAST_FULLPAGE_ATTEMPT_TIMEOUT_MS) || undefined,
      stitchedFullPageSegmentHeight: Number(process.env.PAGE_SHOT_FAST_STITCHED_SEGMENT_HEIGHT) || undefined,
      fastMainCapture: process.env.PAGE_SHOT_FAST_MAIN_CAPTURE === "1",
      fastRelated: process.env.PAGE_SHOT_FAST_RELATED === "1"
    };
    return argUrl
      ? [await captureOne(argUrl, config, captureOptions)]
      : await captureConfiguredUrls(config, captureOptions);
  } catch (error) {
    if (error.code === "CAPTURE_LOCKED") {
      console.log(error.message);
      process.exit(0);
    }
    throw error;
  }
}
