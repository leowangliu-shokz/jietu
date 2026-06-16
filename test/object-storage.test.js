import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncArchiveFileToObjectStorage } from "../src/storage/object-storage.js";

test("syncArchiveFileToObjectStorage records local-only metadata when disabled", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-storage-"));
  const filePath = path.join(tempDir, "shot.png");
  await fs.writeFile(filePath, "image");

  const metadata = await syncArchiveFileToObjectStorage({
    absolutePath: filePath,
    relativePath: "2026-06-16/site/shot.png",
    snapshotId: "snapshot-1"
  }, {
    config: { mode: "disabled" }
  });

  assert.equal(metadata.localPath, "archive/2026-06-16/site/shot.png");
  assert.equal(metadata.syncStatus, "local-only");
  assert.equal(metadata.ossKey, null);
  assert.equal(metadata.sha256.length, 64);
});

test("syncArchiveFileToObjectStorage copies files for local object storage mode", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-storage-"));
  const sourcePath = path.join(tempDir, "shot.png");
  const storageDir = path.join(tempDir, "objects");
  await fs.writeFile(sourcePath, "image");

  const metadata = await syncArchiveFileToObjectStorage({
    absolutePath: sourcePath,
    relativePath: "2026-06-16/site/shot.png",
    snapshotId: "snapshot-1"
  }, {
    config: {
      mode: "local",
      directory: storageDir,
      publicBaseUrl: "https://cdn.example.test/"
    }
  });

  assert.equal(metadata.syncStatus, "synced");
  assert.equal(metadata.ossKey, "2026-06-16/site/snapshot-1.png");
  assert.equal(metadata.objectImageUrl, "https://cdn.example.test/2026-06-16/site/snapshot-1.png");
  assert.equal(await fs.readFile(path.join(storageDir, metadata.ossKey), "utf8"), "image");
});
