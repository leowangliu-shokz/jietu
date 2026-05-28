import fs from "node:fs/promises";
import path from "node:path";
import { logsDir } from "./paths.js";

const captureLockPath = path.join(logsDir, "capture.lock.json");

export async function withCaptureLock(task) {
  const lock = await acquireCaptureLock();
  if (!lock.acquired) {
    const error = new Error(lock.message);
    error.code = "CAPTURE_LOCKED";
    error.statusCode = 409;
    throw error;
  }

  try {
    return await task();
  } finally {
    await lock.release();
  }
}

async function acquireCaptureLock() {
  await fs.mkdir(logsDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(captureLockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          cwd: process.cwd(),
          startedAt: new Date().toISOString()
        }, null, 2));
      } finally {
        await handle.close();
      }
      return {
        acquired: true,
        release: () => releaseCaptureLock()
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const existing = await readCaptureLock();
      if (captureLockIsActive(existing)) {
        return {
          acquired: false,
          message: `Skipped capture because another jietu capture is still running (pid ${existing.pid}, started ${existing.startedAt || "unknown"}).`,
          release: async () => {}
        };
      }

      await fs.rm(captureLockPath, { force: true });
    }
  }

  return {
    acquired: false,
    message: "Skipped capture because the capture lock could not be acquired.",
    release: async () => {}
  };
}

async function readCaptureLock() {
  try {
    return JSON.parse(await fs.readFile(captureLockPath, "utf8"));
  } catch {
    return null;
  }
}

function captureLockIsActive(lock) {
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function releaseCaptureLock() {
  const existing = await readCaptureLock();
  if (Number(existing?.pid) === process.pid) {
    await fs.rm(captureLockPath, { force: true });
  }
}
