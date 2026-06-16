import { fileURLToPath } from "node:url";
import { archiveDir } from "../paths.js";
import { loadSnapshots } from "../store.js";
import { applitoolsConfigFromEnv, compareWithApplitoolsImages } from "./applitools.js";

export async function runApplitoolsSmoke(options = {}) {
  const config = options.config || applitoolsConfigFromEnv(options.env || process.env);
  if (!config) {
    throw new Error("APPLITOOLS_API_KEY is not set");
  }
  const snapshots = options.snapshots || await loadSnapshots();
  const snapshot = selectSnapshot(snapshots, options.snapshotId);
  if (!snapshot) {
    throw new Error(options.snapshotId ? `Snapshot not found: ${options.snapshotId}` : "No snapshots found");
  }
  const result = await compareWithApplitoolsImages(snapshot, snapshot, {
    ...config,
    archiveRoot: options.archiveRoot || archiveDir,
    batchName: options.batchName || `${config.batchName || "jietu"}-smoke`,
    testName: options.testName || `smoke / ${snapshot.id || snapshot.file || "snapshot"}`
  });
  return {
    snapshotId: snapshot.id || null,
    file: snapshot.file || null,
    provider: result.provider,
    status: result.status,
    changed: result.changed,
    isNew: result.isNew,
    isDifferent: result.isDifferent,
    dashboardUrl: result.dashboardUrl
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await runApplitoolsSmoke({
      snapshotId: readArg("--snapshot-id") || undefined
    });
    console.log(`Applitools smoke uploaded snapshot ${result.snapshotId || result.file}`);
    console.log(`Status: ${result.status}; new baseline: ${result.isNew}; different: ${result.isDifferent}`);
    if (result.dashboardUrl) {
      console.log(`Dashboard: ${result.dashboardUrl}`);
    }
  } catch (error) {
    console.error(`Applitools smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function selectSnapshot(snapshots = [], snapshotId = null) {
  const items = (Array.isArray(snapshots) ? snapshots : []).filter((snapshot) => snapshot?.file);
  if (snapshotId) {
    return items.find((snapshot) => snapshot.id === snapshotId) || null;
  }
  return items[0] || null;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}
