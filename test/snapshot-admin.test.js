import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareSnapshots, loadChanges, saveChanges } from "../src/changes.js";
import { encodePng } from "../src/png.js";
import {
  deleteSnapshotAction,
  deleteSnapshotArchive,
  snapshotDeleteDisabledMessage
} from "../src/snapshot-admin.js";
import { readSnapshots } from "../src/store.js";

test("deleteSnapshotArchive removes the snapshot record and its image files", async () => {
  const fixture = await createFixture();
  const primaryFile = "2026-05-12/example-com/snap-1.png";
  const relatedFile = "2026-05-12/example-com/snap-1-topbar.png";
  const survivorFile = "2026-05-12/example-com/snap-2.png";

  await writeArchiveImage(fixture.archiveRoot, primaryFile, solidImage(12, 12, [255, 255, 255, 255]));
  await writeArchiveImage(fixture.archiveRoot, relatedFile, solidImage(12, 12, [0, 0, 0, 255]));
  await writeArchiveImage(fixture.archiveRoot, survivorFile, solidImage(12, 12, [120, 120, 120, 255]));
  await writeSnapshots(fixture.snapshotsFilePath, [
    snapshot("snap-2", "2026-05-12T09:05:00.000Z", survivorFile),
    snapshot("snap-1", "2026-05-12T09:00:00.000Z", primaryFile, [relatedShot(relatedFile)])
  ]);

  const result = await deleteSnapshotArchive("snap-1", {
    archiveRoot: fixture.archiveRoot,
    snapshotsFilePath: fixture.snapshotsFilePath,
    changesFilePath: fixture.changesFilePath
  });

  const savedSnapshots = await readSnapshots(fixture.snapshotsFilePath);
  assert.deepEqual(savedSnapshots.map((item) => item.id), ["snap-2"]);
  assert.equal(await exists(path.join(fixture.archiveRoot, primaryFile)), false);
  assert.equal(await exists(path.join(fixture.archiveRoot, relatedFile)), false);
  assert.equal(await exists(path.join(fixture.archiveRoot, survivorFile)), true);
  assert.equal(result.changeRefresh.count, 0);
  assert.deepEqual(await loadChanges(fixture.changesFilePath), []);
  assert.ok(result.removedFiles.some((item) => item.file === primaryFile && item.status === "deleted"));
  assert.ok(result.removedFiles.some((item) => item.file === relatedFile && item.status === "deleted"));
});

test("deleteSnapshotArchive skips invalid archive paths without deleting outside files", async () => {
  const fixture = await createFixture();
  const outsidePath = path.join(fixture.root, "outside.txt");
  await fs.writeFile(outsidePath, "keep me", "utf8");
  await writeSnapshots(fixture.snapshotsFilePath, [
    snapshot("snap-bad", "2026-05-12T09:00:00.000Z", "../../outside.txt")
  ]);

  const result = await deleteSnapshotArchive("snap-bad", {
    archiveRoot: fixture.archiveRoot,
    snapshotsFilePath: fixture.snapshotsFilePath,
    changesFilePath: fixture.changesFilePath
  });

  assert.equal(await exists(outsidePath), true);
  assert.deepEqual(await readSnapshots(fixture.snapshotsFilePath), []);
  assert.ok(result.removedFiles.some((item) => item.file === "../../outside.txt" && item.status === "skipped-invalid-path"));
});

test("deleteSnapshotArchive rebuilds change links and removes stale diff images", async () => {
  const fixture = await createFixture();
  const firstFile = "2026-05-12/example-com/snap-1.png";
  const middleFile = "2026-05-12/example-com/snap-2.png";
  const lastFile = "2026-05-12/example-com/snap-3.png";

  await writeArchiveImage(fixture.archiveRoot, firstFile, solidImage(12, 12, [255, 255, 255, 255]));
  const middleImage = solidImage(12, 12, [255, 255, 255, 255]);
  fillRect(middleImage, 12, 2, 2, 6, 6, [0, 0, 0, 255]);
  await writeArchiveImage(fixture.archiveRoot, middleFile, middleImage);
  const lastImage = solidImage(12, 12, [255, 255, 255, 255]);
  fillRect(lastImage, 12, 5, 5, 6, 6, [0, 0, 0, 255]);
  await writeArchiveImage(fixture.archiveRoot, lastFile, lastImage);

  const snapshots = [
    snapshot("snap-3", "2026-05-12T10:00:00.000Z", lastFile),
    snapshot("snap-2", "2026-05-12T09:30:00.000Z", middleFile),
    snapshot("snap-1", "2026-05-12T09:00:00.000Z", firstFile)
  ];
  await writeSnapshots(fixture.snapshotsFilePath, snapshots);

  const initialChanges = await compareSnapshots([...snapshots].reverse(), { archiveRoot: fixture.archiveRoot });
  assert.equal(initialChanges.length, 2);
  await saveChanges(initialChanges, fixture.changesFilePath);

  const staleDiffFiles = initialChanges.map((change) => change.visualChange?.diffFile).filter(Boolean);
  for (const relativePath of staleDiffFiles) {
    assert.equal(await exists(path.join(fixture.archiveRoot, relativePath)), true);
  }

  await deleteSnapshotArchive("snap-2", {
    archiveRoot: fixture.archiveRoot,
    snapshotsFilePath: fixture.snapshotsFilePath,
    changesFilePath: fixture.changesFilePath
  });

  const rebuiltChanges = await loadChanges(fixture.changesFilePath);
  assert.equal(rebuiltChanges.length, 1);
  assert.equal(rebuiltChanges[0].from.snapshotId, "snap-1");
  assert.equal(rebuiltChanges[0].to.snapshotId, "snap-3");

  const activeDiffFiles = new Set(
    rebuiltChanges.map((change) => change.visualChange?.diffFile).filter(Boolean)
  );
  for (const relativePath of staleDiffFiles) {
    const shouldExist = activeDiffFiles.has(relativePath);
    assert.equal(
      await exists(path.join(fixture.archiveRoot, relativePath)),
      shouldExist
    );
  }
  for (const relativePath of activeDiffFiles) {
    assert.equal(await exists(path.join(fixture.archiveRoot, relativePath)), true);
  }
});

test("deleteSnapshotAction rejects deletion when snapshot deletion is disabled", async () => {
  const result = await deleteSnapshotAction({
    canDeleteSnapshots: false,
    captureRunning: false,
    snapshotId: "snap-1"
  });

  assert.equal(result.status, 403);
  assert.deepEqual(result.payload, {
    ok: false,
    error: snapshotDeleteDisabledMessage
  });
});

test("deleteSnapshotAction rejects deletion while capture is running", async () => {
  const result = await deleteSnapshotAction({
    canDeleteSnapshots: true,
    captureRunning: true,
    snapshotId: "snap-1"
  });

  assert.equal(result.status, 409);
  assert.equal(result.payload.ok, false);
  assert.match(result.payload.error, /capture is running/i);
});

test("deleteSnapshotAction returns 404 when the snapshot id does not exist", async () => {
  const fixture = await createFixture();
  await writeSnapshots(fixture.snapshotsFilePath, []);

  const result = await deleteSnapshotAction({
    canDeleteSnapshots: true,
    captureRunning: false,
    snapshotId: "missing-snapshot",
    archiveRoot: fixture.archiveRoot,
    snapshotsFilePath: fixture.snapshotsFilePath,
    changesFilePath: fixture.changesFilePath
  });

  assert.equal(result.status, 404);
  assert.equal(result.payload.ok, false);
  assert.match(result.payload.error, /missing-snapshot/);
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "page-shot-delete-"));
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

async function writeSnapshots(filePath, snapshots) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
}

async function writeArchiveImage(archiveRoot, relativePath, rgba) {
  const filePath = path.join(archiveRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, encodePng(12, 12, rgba));
}

function snapshot(id, capturedAt, file, relatedShots = []) {
  return {
    id,
    url: "https://example.com/",
    targetId: "home",
    targetLabel: "Example",
    displayUrl: "Example",
    capturedAt,
    file,
    imageUrl: `/archive/${file}`,
    width: 12,
    height: 12,
    devicePresetId: "pc",
    deviceName: "PC",
    relatedShots
  };
}

function relatedShot(file) {
  return {
    label: "Topbar 1",
    file,
    imageUrl: `/archive/${file}`,
    width: 12,
    height: 12,
    sectionKey: "topbar",
    sectionLabel: "Topbar",
    stateIndex: 1,
    stateCount: 1,
    interactionState: "default"
  };
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

function fillRect(rgba, width, x, y, rectWidth, rectHeight, color) {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let column = x; column < x + rectWidth; column += 1) {
      const offset = (row * width + column) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
