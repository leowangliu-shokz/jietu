import { captureConfiguredUrls, captureOne } from "./capture-service.js";
import { loadConfig } from "./store.js";

const argUrl = process.argv[2];
const config = await loadConfig();
const results = argUrl ? [await captureOne(argUrl, config)] : await captureConfiguredUrls(config);

for (const result of results) {
  if (result.ok) {
    console.log(`Saved ${result.snapshot.url} -> archive/${result.snapshot.file}`);
  } else {
    console.error(`Failed ${result.url}: ${result.error}`);
  }
}

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
