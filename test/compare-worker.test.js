import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCompareWorker, __testOnly } from "../src/compare/worker.js";

test("compare worker defaults to the latest capture run with snapshot ids", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-compare-worker-"));
  const snapshotsFilePath = path.join(tempDir, "snapshots.json");
  const changesFilePath = path.join(tempDir, "changes.json");
  const captureRunsFilePath = path.join(tempDir, "capture-runs.json");
  const notificationsFilePath = path.join(tempDir, "change-notifications.json");
  const logsDir = path.join(tempDir, "logs");

  await fs.writeFile(snapshotsFilePath, `${JSON.stringify([{
    id: "snap-new",
    capturedAt: "2026-06-16T02:00:00.000Z",
    url: "https://example.test/",
    displayUrl: "Example",
    targetId: "example-home",
    platform: "pc",
    devicePresetId: "pc-hd",
    file: "2026-06-16/example/snap-new.png",
    width: 1280,
    height: 2400,
    captureConfidence: { baselineEligible: true }
  }])}\n`, "utf8");
  await fs.writeFile(changesFilePath, "[]\n", "utf8");
  await fs.writeFile(captureRunsFilePath, `${JSON.stringify([
    {
      id: "run-without-snapshots",
      startedAt: "2026-06-16T03:00:00.000Z",
      items: [{ id: "item-empty", snapshotIds: [] }]
    },
    {
      id: "run-with-snapshots",
      startedAt: "2026-06-16T02:00:00.000Z",
      items: [{ id: "item-1", snapshotIds: ["snap-new"] }]
    }
  ])}\n`, "utf8");

  const result = await runCompareWorker({
    snapshotsFilePath,
    changesFilePath,
    captureRunsFilePath,
    notification: { statePath: notificationsFilePath },
    workflow: { logsDir },
    writeDiffImages: false
  });

  assert.equal(result.mode, "incremental");
  assert.equal(result.captureRunId, "run-with-snapshots");
  assert.equal(result.snapshotCount, 1);
  assert.equal(result.count, 0);
  assert.equal(result.workflowRun.tasks[0].status, "completed");
  assert.match(await fs.readFile(result.workflowChecklist, "utf8"), /Compared 1 snapshots/);
  assert.deepEqual(JSON.parse(await fs.readFile(changesFilePath, "utf8")), []);
});

test("compare worker cli args preserve explicit full rebuild mode", () => {
  assert.deepEqual(__testOnly.parseCliArgs(["--all", "--notify", "--run-id", "run-1"]), {
    all: true,
    sendNotifications: true,
    captureRunId: "run-1"
  });
});
