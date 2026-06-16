import { fileURLToPath } from "node:url";
import { loadChanges, rebuildChanges } from "../changes.js";
import { notifyChangeRecords } from "../change-notifier.js";

export async function runCompareWorker(options = {}) {
  const previousChanges = await loadChanges(options.changesFilePath);
  const changes = await rebuildChanges(options);
  const notification = await notifyChangeRecords(changes, {
    previousChanges,
    sendNotifications: options.sendNotifications === true
  }).catch((error) => ({
    ok: false,
    enabled: true,
    error: error.message
  }));
  return {
    ok: true,
    count: changes.length,
    changes,
    notification
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runCompareWorker({
    sendNotifications: process.argv.includes("--notify")
  });
  console.log(`Compare worker saved ${result.count} change records to data/changes.json`);
  if (result.notification?.enabled || result.notification?.recordOnly) {
    const status = result.notification.ok
      ? result.notification.recordOnly
        ? `recorded ${result.notification.recordedCount || 0} without sending`
        : `sent ${result.notification.sentCount || 0}`
      : `failed: ${result.notification.error || result.notification.reason || "unknown error"}`;
    console.log(`Change notification ${status}`);
  }
}
