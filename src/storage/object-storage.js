import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../paths.js";

const defaultObjectStorageDir = path.join(dataDir, "object-storage");

export function objectStorageConfigFromEnv(env = process.env) {
  const mode = cleanText(env.PAGE_SHOT_OBJECT_STORAGE || env.PAGE_SHOT_OSS_MODE || "disabled").toLowerCase();
  const publicBaseUrl = cleanText(env.PAGE_SHOT_OBJECT_STORAGE_PUBLIC_BASE_URL || env.PAGE_SHOT_OSS_PUBLIC_BASE_URL);
  return {
    mode: objectStorageMode(mode),
    directory: cleanText(env.PAGE_SHOT_OBJECT_STORAGE_DIR) || defaultObjectStorageDir,
    publicBaseUrl,
    prefix: normalizeObjectPrefix(env.PAGE_SHOT_OBJECT_STORAGE_PREFIX || env.PAGE_SHOT_OSS_PREFIX),
    region: cleanText(env.PAGE_SHOT_OSS_REGION),
    bucket: cleanText(env.PAGE_SHOT_OSS_BUCKET),
    endpoint: cleanText(env.PAGE_SHOT_OSS_ENDPOINT),
    accessKeyId: cleanText(env.PAGE_SHOT_OSS_ACCESS_KEY_ID || env.OSS_ACCESS_KEY_ID),
    accessKeySecret: cleanText(env.PAGE_SHOT_OSS_ACCESS_KEY_SECRET || env.OSS_ACCESS_KEY_SECRET),
    secure: booleanOption(env.PAGE_SHOT_OSS_SECURE, true)
  };
}

export async function syncArchiveFileToObjectStorage({ absolutePath, relativePath, snapshotId }, options = {}) {
  const config = options.config || objectStorageConfigFromEnv(options.env);
  const sha256 = await sha256File(absolutePath);
  const localPath = `archive/${relativePath}`;
  const ossKey = config.mode === "disabled"
    ? null
    : objectKeyForArchiveFile(relativePath, snapshotId, config.prefix);
  if (config.mode !== "local") {
    if (config.mode === "aliyun") {
      try {
        await uploadToAliyunOss({
          absolutePath,
          ossKey,
          config,
          client: options.client
        });
        return {
          localPath,
          ossKey,
          syncStatus: "synced",
          sha256,
          objectImageUrl: objectImageUrl(config.publicBaseUrl, ossKey)
        };
      } catch (error) {
        return {
          localPath,
          ossKey,
          syncStatus: "failed",
          syncError: error.message,
          sha256
        };
      }
    }
    return {
      localPath,
      ossKey,
      syncStatus: "local-only",
      sha256
    };
  }

  const outputPath = path.join(config.directory, ...ossKey.split("/"));
  try {
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
  } catch (error) {
    return {
      localPath,
      ossKey,
      syncStatus: "failed",
      syncError: error.message,
      sha256
    };
  }
}

function objectKeyForArchiveFile(relativePath, snapshotId, prefix = "") {
  const safeSnapshotId = cleanText(snapshotId).replace(/[^a-z0-9_.-]+/gi, "-");
  const normalized = cleanText(relativePath).replaceAll("\\", "/");
  const key = safeSnapshotId
    ? path.posix.join(path.posix.dirname(normalized), `${safeSnapshotId}${path.posix.extname(normalized) || ".png"}`)
    : normalized;
  return prefix ? path.posix.join(prefix, key) : key;
}

async function uploadToAliyunOss({ absolutePath, ossKey, config, client }) {
  const ossClient = client || await createAliyunOssClient(config);
  await ossClient.put(ossKey, absolutePath, {
    headers: {
      "Content-Type": contentTypeForPath(absolutePath)
    }
  });
}

async function createAliyunOssClient(config = {}) {
  const missing = [];
  if (!config.region && !config.endpoint) {
    missing.push("PAGE_SHOT_OSS_REGION");
  }
  if (!config.bucket) {
    missing.push("PAGE_SHOT_OSS_BUCKET");
  }
  if (!config.accessKeyId) {
    missing.push("PAGE_SHOT_OSS_ACCESS_KEY_ID");
  }
  if (!config.accessKeySecret) {
    missing.push("PAGE_SHOT_OSS_ACCESS_KEY_SECRET");
  }
  if (missing.length) {
    throw new Error(`Aliyun OSS config is missing: ${missing.join(", ")}`);
  }
  const module = await import("ali-oss");
  const OSS = module.default || module.OSS || module;
  return new OSS({
    region: config.region || undefined,
    endpoint: config.endpoint || undefined,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    secure: config.secure !== false
  });
}

function objectStorageMode(value) {
  if (value === "local") {
    return "local";
  }
  if (["aliyun", "ali-oss", "oss"].includes(value)) {
    return "aliyun";
  }
  return "disabled";
}

function normalizeObjectPrefix(value) {
  return cleanText(value)
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "image/png";
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

function booleanOption(value, fallback = false) {
  const text = cleanText(value).toLowerCase();
  if (!text) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(text);
}
