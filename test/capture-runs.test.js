import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendCaptureRun, loadCaptureRuns } from "../src/capture-runs.js";

test("appendCaptureRun stores newest runs first and preserves item status", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-runs-"));
  const filePath = path.join(tempDir, "capture-runs.json");

  await appendCaptureRun({
    id: "run-1",
    status: "succeeded",
    startedAt: "2026-05-20T08:00:00.000Z",
    finishedAt: "2026-05-20T08:10:00.000Z",
    items: [{
      id: "run-1-item-1",
      ok: true,
      status: "succeeded",
      targetId: "home",
      platform: "pc",
      capturePlanId: "home-pc",
      snapshotIds: ["snap-1"]
    }]
  }, { filePath });

  await appendCaptureRun({
    id: "run-2",
    status: "partial",
    startedAt: "2026-05-20T09:00:00.000Z",
    finishedAt: "2026-05-20T09:20:00.000Z",
    jobQueue: {
      totalCount: 1,
      concurrency: 1,
      durationMs: 1200000,
      maxActiveCount: 1
    },
    timings: {
      jobQueueMs: 1200000,
      persistenceMs: 42
    },
    items: [{
      id: "run-2-item-1",
      ok: false,
      status: "failed",
      targetId: "home",
      platform: "mobile",
      capturePlanId: "home-mobile",
      timings: {
        mainCaptureMs: 82000,
        relatedCaptureMs: 0,
        objectStorage: {
          fileCount: 1,
          totalMs: 1200
        },
        relatedSections: [{
          sectionKey: "banner",
          durationMs: 0,
          shotCount: 0
        }]
      },
      retryCount: 1,
      error: "Timed out"
    }]
  }, { filePath });

  const runs = await loadCaptureRuns(filePath);
  assert.deepEqual(runs.map((run) => run.id), ["run-2", "run-1"]);
  assert.equal(runs[0].failureCount, 1);
  assert.equal(runs[0].jobQueue.durationMs, 1200000);
  assert.equal(runs[0].timings.jobQueueMs, 1200000);
  assert.equal(runs[0].items[0].retryCount, 1);
  assert.equal(runs[0].items[0].timings.mainCaptureMs, 82000);
  assert.equal(runs[0].items[0].timings.objectStorage.totalMs, 1200);
  assert.equal(runs[0].items[0].timings.relatedSections[0].sectionKey, "banner");
  assert.equal(runs[0].items[0].error, "Timed out");
  assert.deepEqual(runs[1].items[0].snapshotIds, ["snap-1"]);
});
