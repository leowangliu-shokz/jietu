import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildTextQualitySummary,
  createTextQualityRecord,
  deleteTextQualityRecordsForSnapshotIds,
  loadTextQualityRecords,
  rebuildTextQuality,
  saveTextQualityRecords
} from "../src/text-quality.js";

test("detects spelling and grammar issues with expected wording", async () => {
  const record = await createTextQualityRecord({
    id: "snap-1",
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    displayUrl: "Example",
    platform: "pc",
    devicePresetId: "pc-hd",
    capturedAt: "2026-06-02T08:00:00.000Z",
    title: "Example page",
    relatedShots: [{
      sectionKey: "banner",
      sectionLabel: "Banner",
      stateLabel: "Banner 1",
      imageUrl: "/archive/banner.png",
      sectionState: {
        textBlocks: [
          { text: "This sentense has a regiter label." },
          { text: "The the checkout copy is repeated." }
        ]
      }
    }]
  }, { checkedAt: "2026-06-02T08:05:00.000Z" });

  assert.equal(record.status, "warning");
  assert.ok(record.issues.some((issue) =>
    issue.type === "spelling" &&
    issue.wrong === "sentense" &&
    issue.expected.includes("sentence")
  ));
  assert.ok(record.issues.some((issue) =>
    issue.type === "spelling" &&
    issue.wrong === "regiter" &&
    issue.expected.includes("register")
  ));
  assert.ok(record.issues.some((issue) =>
    issue.type === "grammar" &&
    issue.wrong === "The the" &&
    issue.expected.includes("The checkout")
  ));
});

test("detects known typos in HTML source attributes", async () => {
  const record = await createTextQualityRecord({
    id: "snap-html",
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    displayUrl: "Example",
    platform: "pc",
    devicePresetId: "pc-hd",
    capturedAt: "2026-06-02T08:00:00.000Z",
    title: "Example page"
  }, {
    checkedAt: "2026-06-02T08:05:00.000Z",
    htmlSource: `
      <section class="shopify-section home-page-email-regiter-inner">
        <div class="email_regiter-wrapper"></div>
      </section>
    `
  });

  const classIssue = record.issues.find((issue) =>
    issue.type === "spelling" &&
    issue.source === "html-attribute-technical" &&
    issue.attributeName === "class" &&
    issue.wrong === "regiter"
  );

  assert.ok(classIssue);
  assert.ok(classIssue.expected.includes("register"));
  assert.equal(classIssue.element, "section");
});

test("assigns fetched HTML attribute issues once per platform URL", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-text-quality-"));
  const textQualityFilePath = path.join(tempDir, "text-quality.json");

  const records = await rebuildTextQuality({
    textQualityFilePath,
    snapshots: [
      textQualitySnapshot("snap-nav", "shokz-products-nav", "https://shokz.com/（导航栏）", "2026-06-02T08:10:00.000Z"),
      textQualitySnapshot("snap-home", "shokz-home", "https://shokz.com/（首页）", "2026-06-02T08:00:00.000Z")
    ],
    htmlFetcher: async () => `
      <section class="shopify-section home-page-email-regiter-inner"></section>
    `
  });

  const homeRecord = records.find((record) => record.snapshotId === "snap-home");
  const navRecord = records.find((record) => record.snapshotId === "snap-nav");

  assert.ok(homeRecord.issues.some((issue) => issue.source === "html-attribute-technical" && issue.wrong === "regiter"));
  assert.equal(navRecord.issueCount, 0);
});

test("stores text quality records and deletes them by source snapshot id", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-text-quality-"));
  const textQualityFilePath = path.join(tempDir, "text-quality.json");

  await saveTextQualityRecords([
    textQualityRecord("record-1", "snap-1", 1),
    textQualityRecord("record-2", "snap-2", 0)
  ], textQualityFilePath);

  assert.equal((await loadTextQualityRecords(textQualityFilePath)).length, 2);
  const result = await deleteTextQualityRecordsForSnapshotIds(["snap-1"], {
    textQualityFilePath
  });
  const remaining = await loadTextQualityRecords(textQualityFilePath);

  assert.equal(result.deletedCount, 1);
  assert.deepEqual(remaining.map((record) => record.snapshotId), ["snap-2"]);
  assert.deepEqual(buildTextQualitySummary(remaining), {
    recordCount: 1,
    issueCount: 0,
    okCount: 1,
    warningCount: 0,
    latestRecord: remaining[0],
    recentIssues: []
  });
});

function textQualityRecord(id, snapshotId, issueCount) {
  return {
    id,
    snapshotId,
    capturedAt: snapshotId === "snap-2" ? "2026-06-02T09:00:00.000Z" : "2026-06-02T08:00:00.000Z",
    checkedAt: "2026-06-02T09:05:00.000Z",
    url: "https://example.com/",
    displayUrl: "Example",
    platform: "pc",
    issueCount,
    issues: issueCount
      ? [{
        id: `${id}-issue`,
        type: "spelling",
        level: "P1",
        wrong: "regiter",
        expected: "register",
        context: "regiter"
      }]
      : []
  };
}

function textQualitySnapshot(id, targetId, displayUrl, capturedAt) {
  return {
    id,
    targetId,
    targetLabel: displayUrl,
    displayUrl,
    url: "https://shokz.com/",
    finalUrl: "https://shokz.com/",
    platform: "mobile",
    devicePresetId: "iphone-15",
    capturedAt,
    title: "Example page"
  };
}
