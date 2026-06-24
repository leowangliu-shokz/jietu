import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { objectStorageConfigFromEnv, syncArchiveFileToObjectStorage } from "../src/storage/object-storage.js";

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

test("objectStorageConfigFromEnv reads Aliyun OSS settings", () => {
  const config = objectStorageConfigFromEnv({
    PAGE_SHOT_OBJECT_STORAGE: "aliyun",
    PAGE_SHOT_OSS_REGION: "oss-cn-guangzhou",
    PAGE_SHOT_OSS_BUCKET: "jietu-prod",
    PAGE_SHOT_OSS_ACCESS_KEY_ID: "ak",
    PAGE_SHOT_OSS_ACCESS_KEY_SECRET: "secret",
    PAGE_SHOT_OSS_PREFIX: "/screenshots/",
    PAGE_SHOT_OSS_PUBLIC_BASE_URL: "https://cdn.example.test/screenshots/"
  });

  assert.equal(config.mode, "aliyun");
  assert.equal(config.region, "oss-cn-guangzhou");
  assert.equal(config.bucket, "jietu-prod");
  assert.equal(config.prefix, "screenshots");
  assert.equal(config.publicBaseUrl, "https://cdn.example.test/screenshots/");
});

test("syncArchiveFileToObjectStorage uploads to Aliyun OSS with a client adapter", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-storage-"));
  const sourcePath = path.join(tempDir, "shot.png");
  const uploaded = [];
  await fs.writeFile(sourcePath, "image");

  const metadata = await syncArchiveFileToObjectStorage({
    absolutePath: sourcePath,
    relativePath: "2026-06-16/site/shot.png",
    snapshotId: "snapshot-1"
  }, {
    config: {
      mode: "aliyun",
      prefix: "screenshots",
      publicBaseUrl: "https://cdn.example.test/"
    },
    client: {
      async put(key, filePath, options) {
        uploaded.push({ key, filePath, contentType: options.headers["Content-Type"] });
      }
    }
  });

  assert.equal(metadata.syncStatus, "synced");
  assert.equal(metadata.ossKey, "screenshots/2026-06-16/site/snapshot-1.png");
  assert.equal(metadata.objectImageUrl, "https://cdn.example.test/screenshots/2026-06-16/site/snapshot-1.png");
  assert.deepEqual(uploaded, [{
    key: "screenshots/2026-06-16/site/snapshot-1.png",
    filePath: sourcePath,
    contentType: "image/png"
  }]);
});

test("syncArchiveFileToObjectStorage does not fail capture metadata when OSS upload fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-storage-"));
  const sourcePath = path.join(tempDir, "shot.png");
  await fs.writeFile(sourcePath, "image");

  const metadata = await syncArchiveFileToObjectStorage({
    absolutePath: sourcePath,
    relativePath: "2026-06-16/site/shot.png",
    snapshotId: "snapshot-1"
  }, {
    config: {
      mode: "aliyun",
      prefix: "screenshots"
    },
    client: {
      async put() {
        throw new Error("network unavailable");
      }
    }
  });

  assert.equal(metadata.syncStatus, "failed");
  assert.equal(metadata.ossKey, "screenshots/2026-06-16/site/snapshot-1.png");
  assert.match(metadata.syncError, /network unavailable/);
  assert.equal(metadata.sha256.length, 64);
});
