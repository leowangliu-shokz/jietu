import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rebuildChanges } from "../src/changes.js";
import { encodePng } from "../src/png.js";
import { repairSnapshotsRuntimeMetadata } from "../src/runtime-data-repair.js";
import { readSnapshots, saveSnapshots } from "../src/store.js";

test("repairSnapshotsRuntimeMetadata fixes corrupted runtime labels and rebuilt changes", async () => {
  const fixture = await createFixture();
  const olderFile = "2026-05-12/example-com/snap-1.png";
  const newerFile = "2026-05-12/example-com/snap-2.png";
  const olderRelatedFile = "2026-05-12/example-com/snap-1-topbar.png";
  const newerRelatedFile = "2026-05-12/example-com/snap-2-topbar.png";

  await writeArchiveImage(fixture.archiveRoot, olderFile, solidImage(12, 12, [255, 255, 255, 255]));
  await writeArchiveImage(fixture.archiveRoot, newerFile, solidImage(12, 12, [15, 15, 15, 255]));
  await writeArchiveImage(fixture.archiveRoot, olderRelatedFile, solidImage(12, 12, [255, 255, 255, 255]));
  await writeArchiveImage(fixture.archiveRoot, newerRelatedFile, solidImage(12, 12, [0, 0, 0, 255]));

  const corruptedSnapshots = [
    corruptedSnapshot("snap-2", "2026-05-12T09:05:00.000Z", newerFile, newerRelatedFile),
    corruptedSnapshot("snap-1", "2026-05-12T09:00:00.000Z", olderFile, olderRelatedFile)
  ];

  const repairResult = repairSnapshotsRuntimeMetadata(corruptedSnapshots, {
    targets: [
      {
        id: "shokz-home",
        url: "https://shokz.com/",
        label: "https://shokz.com/（首页）"
      }
    ]
  });

  assert.equal(repairResult.stats.snapshotCountTouched, 2);
  assert.equal(repairResult.snapshots[0].targetLabel, "https://shokz.com/（首页）");
  assert.equal(repairResult.snapshots[0].displayUrl, "https://shokz.com/（首页）");
  assert.equal(repairResult.snapshots[0].deviceLabel, "iPhone 15（393×852）");
  assert.equal(repairResult.snapshots[0].relatedShots[0].sectionLabel, "Topbar");
  assert.equal(repairResult.snapshots[0].relatedShots[0].sectionTitle, "Topbar 轮播图");
  assert.equal(repairResult.snapshots[0].id, corruptedSnapshots[0].id);
  assert.equal(repairResult.snapshots[0].file, corruptedSnapshots[0].file);
  assert.equal(repairResult.snapshots[0].capturedAt, corruptedSnapshots[0].capturedAt);
  assert.equal(repairResult.snapshots[0].relatedShots[0].file, corruptedSnapshots[0].relatedShots[0].file);
  assert.ok(!JSON.stringify(repairResult.snapshots).includes("???"));

  await saveSnapshots(repairResult.snapshots, fixture.snapshotsFilePath);
  const rebuiltChanges = await rebuildChanges({
    snapshots: repairResult.snapshots,
    archiveRoot: fixture.archiveRoot,
    changesFilePath: fixture.changesFilePath
  });

  assert.equal(rebuiltChanges.length, 2);
  assert.ok(!JSON.stringify(rebuiltChanges).includes("???"));
  assert.equal(rebuiltChanges[0].location.displayUrl, "https://shokz.com/（首页）");
  assert.equal(rebuiltChanges.find((change) => change.location.sectionKey === "topbar").location.sectionTitle, "Topbar 轮播图");

  const savedSnapshots = await readSnapshots(fixture.snapshotsFilePath);
  assert.equal(savedSnapshots[0].targetLabel, "https://shokz.com/（首页）");
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-repair-"));
  const archiveRoot = path.join(root, "archive");
  const dataDir = path.join(root, "data");
  await fs.mkdir(archiveRoot, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  return {
    root,
    archiveRoot,
    snapshotsFilePath: path.join(dataDir, "snapshots.json"),
    changesFilePath: path.join(dataDir, "changes.json")
  };
}

function corruptedSnapshot(id, capturedAt, file, relatedFile) {
  return {
    id,
    url: "https://shokz.com/",
    requestedUrl: "https://shokz.com/",
    finalUrl: "https://shokz.com/",
    targetId: "shokz-home",
    targetLabel: "https://shokz.com/????",
    displayUrl: "https://shokz.com/????",
    title: "Open-Ear & Bone Conduction Headphones | Shokz Official",
    capturedAt,
    file,
    imageUrl: `/archive/${file}`,
    width: 393,
    height: 852,
    scrollInfo: {
      viewportHeight: 852
    },
    devicePresetId: "iphone-15",
    deviceName: "iPhone 15",
    deviceLabel: "iPhone 15?393?852?",
    relatedShots: [
      {
        kind: "banner",
        sectionKey: "topbar",
        sectionLabel: "Topbar",
        sectionTitle: "Topbar ???",
        label: "Topbar 1",
        stateLabel: "Topbar 1",
        file: relatedFile,
        imageUrl: `/archive/${relatedFile}`,
        width: 393,
        height: 40,
        stateIndex: 1,
        stateCount: 4,
        pageIndex: 1,
        tabIndex: 1,
        interactionState: "default"
      }
    ],
    relatedValidation: {
      status: "ok",
      warnings: [],
      sections: [
        {
          sectionKey: "topbar",
          sectionLabel: "Topbar",
          expectedCount: 4,
          capturedCount: 4,
          savedCount: 4,
          status: "ok"
        }
      ]
    }
  };
}

async function writeArchiveImage(archiveRoot, relativePath, rgba) {
  const filePath = path.join(archiveRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, encodePng(12, 12, rgba));
}

function solidImage(width, height, color) {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = color[3];
  }
  return rgba;
}
