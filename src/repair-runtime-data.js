import { rebuildChanges } from "./changes.js";
import { readSnapshots, saveSnapshots, loadConfig } from "./store.js";
import { repairSnapshotsRuntimeMetadata } from "./runtime-data-repair.js";

const config = await loadConfig();
const snapshots = await readSnapshots();
const result = repairSnapshotsRuntimeMetadata(snapshots, {
  targets: config.urls
});

await saveSnapshots(result.snapshots);
const changes = await rebuildChanges({ snapshots: result.snapshots });

console.log(`Repaired ${result.stats.snapshotCountTouched} snapshots.`);
console.log(JSON.stringify({
  snapshotCount: result.snapshots.length,
  changeCount: changes.length,
  stats: result.stats
}, null, 2));
