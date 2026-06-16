import { runCompareWorker } from "./compare/worker.js";

const result = await runCompareWorker({ sendNotifications: false });
console.log(`Saved ${result.count} change records to data/changes.json`);
const notification = result.notification;
if (notification.enabled || notification.recordOnly) {
  const sent = notification.sentCount || 0;
  const status = notification.ok
    ? notification.recordOnly
      ? `recorded ${notification.recordedCount || 0} without sending`
      : `sent ${sent}`
    : `failed: ${notification.error || notification.reason || "unknown error"}`;
  console.log(`Change notification ${status}`);
}
