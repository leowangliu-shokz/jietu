import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = path.join(rootDir, "data");
export const archiveDir = path.join(rootDir, "archive");
export const logsDir = path.join(rootDir, "logs");
export const publicDir = path.join(rootDir, "public");
export const configPath = path.join(dataDir, "config.json");
export const snapshotsPath = path.join(dataDir, "snapshots.json");
export const changesPath = path.join(dataDir, "changes.json");
export const captureIssuesPath = path.join(dataDir, "capture-issues.json");
