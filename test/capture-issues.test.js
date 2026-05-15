import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { loadCaptureIssues, markCaptureTileIssue } from "../src/capture-issues.js";

test("markCaptureTileIssue records one open issue per snapshot tile", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-issues-"));
  const filePath = path.join(tempDir, "capture-issues.json");
  try {
    const first = await markCaptureTileIssue({
      snapshotId: "snapshot-1",
      overviewFile: "2026-05-15/site/home-overview.png",
      tileKey: "banner:2",
      tileLabel: "Banner 2",
      sectionKey: "banner",
      sectionLabel: "Banner",
      sourceFile: "2026-05-15/site/banner-2.png",
      rect: { x: 100.4, y: 20.2, width: 80.6, height: 40.1 }
    }, { filePath });
    const second = await markCaptureTileIssue({
      snapshotId: "snapshot-1",
      tileKey: "banner:2",
      tileLabel: "Banner 2 updated",
      sectionKey: "banner"
    }, { filePath });
    const issues = await loadCaptureIssues(filePath);

    assert.equal(issues.length, 1);
    assert.equal(first.id, second.id);
    assert.equal(issues[0].tileLabel, "Banner 2 updated");
    assert.equal(issues[0].rect.width, 81);
    assert.equal(issues[0].status, "open");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
