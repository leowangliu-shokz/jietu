import assert from "node:assert/strict";
import test from "node:test";
import {
  renderWorkflowChecklistMarkdown,
  workflowTasksFromCaptureResults,
  workflowTasksFromCompareResult
} from "../src/jobs/workflow-tasks.js";

test("workflowTasksFromCaptureResults marks healthy captures complete", () => {
  const [task] = workflowTasksFromCaptureResults([{
    ok: true,
    displayUrl: "Home",
    platform: "pc",
    capturePlanId: "plan-home-pc",
    snapshots: [{
      id: "snapshot-1",
      file: "2026-06-16/site/snapshot.png",
      imageUrl: "/archive/2026-06-16/site/snapshot.png",
      width: 1200,
      height: 4000
    }]
  }]);

  assert.equal(task.status, "completed");
  assert.equal(task.checked, true);
  assert.equal(task.recordId, "snapshot-1");
});

test("workflowTasksFromCaptureResults fails captures that do not pass self check", () => {
  const [task] = workflowTasksFromCaptureResults([{
    ok: true,
    displayUrl: "Home",
    snapshots: [{
      id: "snapshot-1",
      file: "2026-06-16/site/snapshot.png",
      imageUrl: "/archive/2026-06-16/site/snapshot.png",
      width: 0,
      height: 4000
    }]
  }]);

  assert.equal(task.status, "failed");
  assert.equal(task.checked, false);
  assert.match(task.error, /dimensions are invalid/);
});

test("workflowTasksFromCompareResult creates a no-change checklist task", () => {
  const [task] = workflowTasksFromCompareResult({ changes: [] });
  const markdown = renderWorkflowChecklistMarkdown({
    id: "compare-1",
    type: "compare",
    title: "Compare",
    tasks: [task]
  });

  assert.equal(task.status, "completed");
  assert.match(markdown, /No recordable changes/);
});

test("workflowTasksFromCompareResult marks skipped compare work", () => {
  const [task] = workflowTasksFromCompareResult({
    changes: [],
    skippedReason: "No capture run found"
  });

  assert.equal(task.status, "skipped");
  assert.equal(task.checked, false);
  assert.equal(task.message, "No capture run found");
});
