import { captureConfiguredUrls, captureOne } from "./capture-service.js";
import { loadConfig } from "./store.js";

const argUrl = process.argv[2];
const config = await loadConfig();
const results = argUrl ? [await captureOne(argUrl, config)] : await captureConfiguredUrls(config);

for (const result of results) {
  if (result.ok) {
    for (const snapshot of result.snapshots || [result.snapshot]) {
      console.log(`Saved ${snapshot.displayUrl || snapshot.url} -> archive/${snapshot.file}`);
    }
  } else {
    console.error(`Failed ${result.displayUrl || result.url}: ${result.error}`);
  }
}

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
