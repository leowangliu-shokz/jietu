import assert from "node:assert/strict";
import test from "node:test";
import { boundedConcurrency, runJobQueue } from "../src/job-queue.js";

test("boundedConcurrency clamps invalid and excessive values", () => {
  assert.equal(boundedConcurrency("bad", { defaultValue: 2, max: 4 }), 2);
  assert.equal(boundedConcurrency(0, { defaultValue: 2, max: 4 }), 1);
  assert.equal(boundedConcurrency(9, { defaultValue: 2, max: 4 }), 4);
});

test("runJobQueue preserves result order and respects concurrency", async () => {
  let activeCount = 0;
  let observedMaxActiveCount = 0;
  const queue = await runJobQueue([3, 1, 2, 4], async (value) => {
    activeCount += 1;
    observedMaxActiveCount = Math.max(observedMaxActiveCount, activeCount);
    await new Promise((resolve) => setTimeout(resolve, value * 5));
    activeCount -= 1;
    return value * 10;
  }, {
    concurrency: 2,
    maxConcurrency: 4
  });

  assert.equal(queue.totalCount, 4);
  assert.equal(queue.concurrency, 2);
  assert.equal(queue.successCount, 4);
  assert.equal(queue.failureCount, 0);
  assert.equal(queue.maxActiveCount, observedMaxActiveCount);
  assert.ok(observedMaxActiveCount <= 2);
  assert.deepEqual(queue.results.map((result) => result.value), [30, 10, 20, 40]);
});
