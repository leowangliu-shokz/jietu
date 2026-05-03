import { rebuildChanges } from "./changes.js";

const changes = await rebuildChanges();
console.log(`Saved ${changes.length} change records to data/changes.json`);
