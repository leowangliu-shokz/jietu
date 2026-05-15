import fs from "node:fs/promises";
import path from "node:path";
import { captureIssuesPath } from "./paths.js";

export async function loadCaptureIssues(filePath = captureIssuesPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(parsed)
      ? parsed.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      : [];
  } catch {
    return [];
  }
}

export async function saveCaptureIssues(issues, filePath = captureIssuesPath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const records = Array.isArray(issues) ? issues : [];
  await fs.writeFile(filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return records;
}

export async function markCaptureTileIssue(input, options = {}) {
  const filePath = options.filePath || captureIssuesPath;
  const snapshotId = cleanText(input?.snapshotId);
  const tileKey = cleanText(input?.tileKey);
  if (!snapshotId) {
    throw new Error("Snapshot id is required.");
  }
  if (!tileKey) {
    throw new Error("Tile key is required.");
  }

  const now = new Date().toISOString();
  const issues = await loadCaptureIssues(filePath);
  const existing = issues.find((issue) =>
    issue.snapshotId === snapshotId &&
    issue.tileKey === tileKey &&
    issue.status !== "resolved"
  );
  const nextIssue = {
    ...(existing || {}),
    id: existing?.id || issueId(snapshotId, tileKey, now),
    snapshotId,
    overviewFile: cleanText(input?.overviewFile) || existing?.overviewFile || "",
    tileKey,
    tileLabel: cleanText(input?.tileLabel) || existing?.tileLabel || "",
    sectionKey: cleanText(input?.sectionKey) || existing?.sectionKey || "",
    sectionLabel: cleanText(input?.sectionLabel) || existing?.sectionLabel || "",
    sourceFile: cleanText(input?.sourceFile) || existing?.sourceFile || "",
    sourceImageUrl: cleanText(input?.sourceImageUrl) || existing?.sourceImageUrl || "",
    rect: normalizeRect(input?.rect) || existing?.rect || null,
    note: cleanText(input?.note) || existing?.note || "",
    status: "open",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  const nextIssues = existing
    ? issues.map((issue) => issue.id === existing.id ? nextIssue : issue)
    : [nextIssue, ...issues];
  await saveCaptureIssues(nextIssues, filePath);
  return nextIssue;
}

function issueId(snapshotId, tileKey, createdAt) {
  return [
    "capture-issue",
    snapshotId,
    tileKey,
    createdAt
  ].map((part) => cleanText(part).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("-")
    .slice(0, 240);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== "object") {
    return null;
  }
  const next = {
    x: Math.max(0, Math.round(Number(rect.x || 0))),
    y: Math.max(0, Math.round(Number(rect.y || 0))),
    width: Math.max(0, Math.round(Number(rect.width || 0))),
    height: Math.max(0, Math.round(Number(rect.height || 0)))
  };
  return next.width > 0 && next.height > 0 ? next : null;
}
