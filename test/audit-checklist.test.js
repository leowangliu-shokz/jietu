import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuditTasks,
  completeModuleTasks,
  createAuditRun,
  mergeAuditRunProgress,
  moduleIsComplete,
  renderAuditChecklistMarkdown
} from "../src/jobs/audit-checklist.js";

const config = {
  targets: [
    { id: "home", url: "https://example.com/", label: "Home" }
  ],
  deviceProfiles: [
    { id: "pc-default", platform: "pc", devicePresetId: "pc-hd", enabled: true },
    { id: "mobile-default", platform: "mobile", devicePresetId: "iphone-15", enabled: true }
  ],
  capturePlans: [
    { id: "plan-home-pc", targetId: "home", deviceProfileId: "pc-default", enabled: true },
    { id: "plan-home-mobile", targetId: "home", deviceProfileId: "mobile-default", enabled: true }
  ]
};

test("buildAuditTasks expands modules across capture plans", () => {
  const tasks = buildAuditTasks(config, {
    date: "2026-06-16",
    modules: ["seo", "woodpecker"]
  });

  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((task) => task.module), ["seo", "seo", "woodpecker", "woodpecker"]);
  assert.deepEqual(tasks.map((task) => task.capturePlanId), [
    "plan-home-pc",
    "plan-home-mobile",
    "plan-home-pc",
    "plan-home-mobile"
  ]);
});

test("completeModuleTasks checks matching records and leaves missing tasks actionable", () => {
  let run = createAuditRun(config, {
    date: "2026-06-16",
    modules: ["seo"]
  });

  run = completeModuleTasks(run, "seo", [{
    id: "seo-record-1",
    capturePlanId: "plan-home-pc",
    targetId: "home",
    platform: "pc",
    deviceProfileId: "pc-default"
  }], {
    missingRecordMessage: "missing seo"
  });

  assert.equal(run.completedCount, 1);
  assert.equal(run.failedCount, 1);
  assert.equal(run.tasks[0].checked, true);
  assert.equal(run.tasks[1].checked, false);
  assert.equal(run.tasks[1].error, "missing seo");

  const markdown = renderAuditChecklistMarkdown(run);
  assert.match(markdown, /- \[x\] Home \/ PC/);
  assert.match(markdown, /- \[ \] Home \/ Mobile/);
  assert.match(markdown, /原因：missing seo/);
});

test("mergeAuditRunProgress keeps completed tasks across resumed runs", () => {
  const previousRun = completeModuleTasks(createAuditRun(config, {
    date: "2026-06-16",
    modules: ["seo"]
  }), "seo", [{
    id: "seo-record-1",
    capturePlanId: "plan-home-pc"
  }, {
    id: "seo-record-2",
    capturePlanId: "plan-home-mobile"
  }]);
  const nextRun = createAuditRun(config, {
    date: "2026-06-16",
    modules: ["seo"]
  });

  const merged = mergeAuditRunProgress(nextRun, previousRun);

  assert.equal(merged.completedCount, 2);
  assert.equal(moduleIsComplete(merged, "seo"), true);
  assert.equal(merged.tasks[0].recordId, "seo-record-1");
  assert.equal(merged.tasks[1].recordId, "seo-record-2");
});
