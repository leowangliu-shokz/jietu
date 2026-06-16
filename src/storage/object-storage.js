import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../paths.js";

const defaultObjectStorageDir = path.join(dataDir, "object-storage");

export function objectStorageConfigFromEnv(env = process.env) {
  const mode = cleanText(env.PAGE_SHOT_OBJECT_STORAGE || env.PAGE_SHOT_OSS_MODE || "disabled").toLowerCase();
  return {
    mode: mode === "local" ? "local" : "disabled",
    directory: cleanText(env.PAGE_SHOT_OBJECT_STORAGE_DIR) || defaultObjectStorageDir,
    publicBaseUrl: cleanText(env.PAGE_SHOT_OBJECT_STORAGE_PUBLIC_BASE_URL)
  };
}

export async function syncArchiveFileToObjectStorage({ absolutePath, relativePath, snapshotId }, options = {}) {
  const config = options.config || objectStorageConfigFromEnv(options.env);
  const sha256 = await sha256File(absolutePath);
  const localPath = `archive/${relativePath}`;
  if (config.mode !== "local") {
    return {
      localPath,
      ossKey: null,
      syncStatus: "local-only",
      sha256
    };
  }

  const ossKey = objectKeyForArchiveFile(relativePath, snapshotId);
  const outputPath = path.join(config.directory, ...ossKey.split("/"));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(absolutePath, outputPath);
  return {
    localPath,
    ossKey,
    syncStatus: "synced",
    sha256,
    objectStoragePath: outputPath,
    objectImageUrl: objectImageUrl(config.publicBaseUrl, ossKey)
  };
}

function objectKeyForArchiveFile(relativePath, snapshotId) {
  const safeSnapshotId = cleanText(snapshotId).replace(/[^a-z0-9_.-]+/gi, "-");
  const normalized = cleanText(relativePath).replaceAll("\\", "/");
  if (!safeSnapshotId) {
    return normalized;
  }
  const dir = path.posix.dirname(normalized);
  const ext = path.posix.extname(normalized) || ".png";
  return path.posix.join(dir, `${safeSnapshotId}${ext}`);
}

function objectImageUrl(publicBaseUrl, ossKey) {
  const base = cleanText(publicBaseUrl);
  if (!base) {
    return null;
  }
  return new URL(ossKey.split("/").map(encodeURIComponent).join("/"), base.endsWith("/") ? base : `${base}/`).toString();
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function cleanText(value) {
  return String(value || "").trim();
}
