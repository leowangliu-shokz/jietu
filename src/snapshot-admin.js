import fs from "node:fs/promises";
import path from "node:path";
import { compareSnapshots, saveChanges } from "./changes.js";
import { archiveDir, changesPath, snapshotsPath } from "./paths.js";
import { readSnapshots, saveSnapshots } from "./store.js";

export const viewerModeErrorMessage = "Viewer mode is read-only for capture and config changes. Set PAGE_SHOT_ADMIN=1 to enable admin actions.";
export const snapshotDeleteDisabledMessage = "Snapshot deletion is disabled.";
const captureRunningDeleteMessage = "Cannot delete snapshots while a capture is running.";

export class SnapshotAdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SnapshotAdminError";
    this.code = code;
  }
}

export async function deleteSnapshotAction(options = {}) {
  if (options.canDeleteSnapshots === false) {
    return {
      status: 403,
      payload: { ok: false, error: snapshotDeleteDisabledMessage }
    };
  }

  if (options.captureRunning) {
    return {
      status: 409,
      payload: { ok: false, error: captureRunningDeleteMessage }
    };
  }

  try {
    const result = await deleteSnapshotArchive(options.snapshotId, options);
    return {
      status: 200,
      payload: {
        ok: true,
        deletedSnapshotId: result.deletedSnapshotId,
        removedFiles: result.removedFiles,
        changeRefresh: result.changeRefresh,
        state: options.buildState ? await options.buildState() : null
      }
    };
  } catch (error) {
    if (error instanceof SnapshotAdminError) {
      const status = error.code === "SNAPSHOT_NOT_FOUND"
        ? 404
        : error.code === "SNAPSHOT_ID_REQUIRED"
          ? 400
          : 409;
      return {
        status,
        payload: { ok: false, error: error.message }
      };
    }
    throw error;
  }
}

export async function deleteSnapshotArchive(snapshotId, options = {}) {
  const cleanSnapshotId = String(snapshotId || "").trim();
  if (!cleanSnapshotId) {
    throw new SnapshotAdminError("SNAPSHOT_ID_REQUIRED", "Snapshot id is required.");
  }

  const archiveRoot = path.resolve(options.archiveRoot || archiveDir);
  const snapshotsFilePath = options.snapshotsFilePath || snapshotsPath;
  const changesFilePath = options.changesFilePath || changesPath;
  const snapshots = await readSnapshots(snapshotsFilePath);
  const snapshot = snapshots.find((item) => item.id === cleanSnapshotId);
  if (!snapshot) {
    throw new SnapshotAdminError("SNAPSHOT_NOT_FOUND", `Snapshot not found: ${cleanSnapshotId}`);
  }

  const remainingSnapshots = snapshots.filter((item) => item.id !== cleanSnapshotId);
  await saveSnapshots(remainingSnapshots, snapshotsFilePath);

  let changes;
  try {
    changes = await compareSnapshots(remainingSnapshots, {
      ...options,
      archiveRoot
    });
    await saveChanges(changes, changesFilePath);
  } catch (error) {
    await saveSnapshots(snapshots, snapshotsFilePath);
    throw error;
  }

  const removedFiles = await removeSnapshotFiles(snapshot, archiveRoot);
  const removedDiffFiles = await cleanupUnusedDiffFiles(changes, archiveRoot);

  return {
    deletedSnapshotId: cleanSnapshotId,
    removedFiles: [...removedFiles, ...removedDiffFiles],
    changeRefresh: {
      ok: true,
      count: changes.length
    }
  };
}

async function removeSnapshotFiles(snapshot, archiveRoot) {
  const files = uniqueFileList([
    snapshot?.file,
    snapshot?.homeOverview?.file,
    ...(snapshot?.relatedShots || []).map((shot) => shot?.file),
    ...snapshotRelatedSourceFiles(snapshot)
  ]);
  return removeArchiveFiles(files, archiveRoot);
}

function snapshotRelatedSourceFiles(snapshot) {
  const files = [];
  const collectItems = (items) => {
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items) {
      if (item?.sourceFile) {
        files.push(item.sourceFile);
      }
    }
  };
  for (const shot of snapshot?.relatedShots || []) {
    collectItems(shot.visibleItems);
    collectItems(shot.composite?.variants);
  }
  collectItems(snapshot?.homeOverview?.visibleItems);
  collectItems(snapshot?.homeOverview?.composite?.variants);
  return files;
}

async function cleanupUnusedDiffFiles(changes, archiveRoot) {
  const diffsRoot = path.join(archiveRoot, "diffs");
  if (!await pathExists(diffsRoot)) {
    return [];
  }

  const referencedDiffs = new Set(
    (Array.isArray(changes) ? changes : [])
      .map((change) => normalizeArchiveRelativePath(change?.visualChange?.diffFile))
      .filter(Boolean)
  );
  const files = await listFilesRecursively(diffsRoot);
  const removable = files
    .map((filePath) => normalizeArchiveRelativePath(path.relative(archiveRoot, filePath)))
    .filter((relativePath) => relativePath && !referencedDiffs.has(relativePath));

  const removedFiles = await removeArchiveFiles(removable, archiveRoot);
  await removeEmptyDirectories(diffsRoot);
  return removedFiles;
}

async function removeArchiveFiles(relativePaths, archiveRoot) {
  const removedFiles = [];
  for (const relativePath of uniqueFileList(relativePaths)) {
    const absolutePath = resolveArchivePath(archiveRoot, relativePath);
    if (!absolutePath) {
      removedFiles.push({ file: normalizeArchiveRelativePath(relativePath), status: "skipped-invalid-path" });
      continue;
    }

    const existed = await pathExists(absolutePath);
    try {
      await fs.rm(absolutePath, { force: true });
    } catch (error) {
      if (isMissingError(error)) {
        removedFiles.push({ file: normalizeArchiveRelativePath(relativePath), status: "missing" });
        continue;
      }
      throw error;
    }

    removedFiles.push({
      file: normalizeArchiveRelativePath(relativePath),
      status: existed ? "deleted" : "missing"
    });
  }
  return removedFiles;
}

function resolveArchivePath(archiveRoot, relativePath) {
  const cleanPath = String(relativePath || "").trim().replace(/^[/\\]+/, "");
  if (!cleanPath) {
    return null;
  }

  const root = path.resolve(archiveRoot);
  const resolved = path.resolve(root, cleanPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function uniqueFileList(values) {
  return [...new Set((values || []).map((value) => normalizeArchiveRelativePath(value)).filter(Boolean))];
}

function normalizeArchiveRelativePath(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

async function listFilesRecursively(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function removeEmptyDirectories(dirPath) {
  if (!await pathExists(dirPath)) {
    return;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeEmptyDirectories(path.join(dirPath, entry.name));
    }
  }

  const remaining = await fs.readdir(dirPath);
  if (remaining.length === 0) {
    await fs.rmdir(dirPath);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isMissingError(error) {
  return error?.code === "ENOENT";
}
