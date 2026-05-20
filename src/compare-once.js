import { loadChanges, rebuildChanges } from "./changes.js";
import { notifyChangeRecords } from "./change-notifier.js";

const previousChanges = await loadChanges();
const changes = await rebuildChanges();
console.log(`Saved ${changes.length} change records to data/changes.json`);
const notification = await notifyChangeRecords(changes, { previousChanges }).catch((error) => ({
  ok: false,
  enabled: true,
  error: error.message
}));
if (notification.enabled) {
  const sent = notification.sentCount || 0;
  const status = notification.ok ? `sent ${sent}` : `failed: ${notification.error || notification.reason || "unknown error"}`;
  console.log(`Change notification ${status}`);
}
