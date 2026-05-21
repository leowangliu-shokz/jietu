import { loadChanges, rebuildChanges } from "./changes.js";
import { notifyChangeRecords } from "./change-notifier.js";

const previousChanges = await loadChanges();
const changes = await rebuildChanges();
console.log(`Saved ${changes.length} change records to data/changes.json`);
const notification = await notifyChangeRecords(changes, { previousChanges, sendNotifications: false }).catch((error) => ({
  ok: false,
  enabled: true,
  error: error.message
}));
if (notification.enabled || notification.recordOnly) {
  const sent = notification.sentCount || 0;
  const status = notification.ok
    ? notification.recordOnly
      ? `recorded ${notification.recordedCount || 0} without sending`
      : `sent ${sent}`
    : `failed: ${notification.error || notification.reason || "unknown error"}`;
  console.log(`Change notification ${status}`);
}
