import assert from "node:assert/strict";
import test from "node:test";
import { runScheduledCycle, __testOnly } from "../src/scheduler/local.js";

test("scheduled cycle defaults to capture only", async () => {
  let compareCalled = false;
  const result = await runScheduledCycle({
    captureRunner: async () => ({ ok: true, id: "capture" }),
    compareRunner: async () => {
      compareCalled = true;
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.compare, null);
  assert.equal(compareCalled, false);
});

test("scheduled cycle runs compare only when explicitly enabled", async () => {
  let compareCalled = false;
  const result = await runScheduledCycle({
    runCompare: true,
    captureRunner: async () => ({ ok: true, id: "capture" }),
    compareRunner: async () => {
      compareCalled = true;
      return { ok: true, count: 0 };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.compare.count, 0);
  assert.equal(compareCalled, true);
});

test("scheduler compare flag can be enabled from env", () => {
  const previous = process.env.PAGE_SHOT_SCHEDULER_COMPARE;
  process.env.PAGE_SHOT_SCHEDULER_COMPARE = "1";
  try {
    assert.equal(__testOnly.shouldRunCompare({}), true);
    assert.equal(__testOnly.shouldRunCompare({ runCompare: false }), false);
  } finally {
    if (previous === undefined) {
      delete process.env.PAGE_SHOT_SCHEDULER_COMPARE;
    } else {
      process.env.PAGE_SHOT_SCHEDULER_COMPARE = previous;
    }
  }
});

test("daily audit is disabled by default for the local scheduler", () => {
  const previous = process.env.PAGE_SHOT_SCHEDULER_DAILY_AUDIT;
  delete process.env.PAGE_SHOT_SCHEDULER_DAILY_AUDIT;
  try {
    assert.equal(__testOnly.shouldRunDailyAudit({}, null), false);
    assert.equal(__testOnly.shouldRunDailyAudit({ runDailyAudit: true }, null), true);
    assert.equal(__testOnly.shouldRunDailyAudit({ runDailyAudit: false }, null), false);
  } finally {
    if (previous !== undefined) {
      process.env.PAGE_SHOT_SCHEDULER_DAILY_AUDIT = previous;
    }
  }
});
