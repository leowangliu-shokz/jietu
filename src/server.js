import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { captureAllDevices, captureConfiguredUrls, captureOne, browserStatus } from "./capture-service.js";
import { loadCaptureIssues, markCaptureTileIssue } from "./capture-issues.js";
import { loadChanges } from "./changes.js";
import { archiveDir, publicDir } from "./paths.js";
import { safeJoin } from "./path-safety.js";
import { annotateChangesForResponse, buildStatePayload } from "./server-state.js";
import { deleteSnapshotAction, viewerModeErrorMessage } from "./snapshot-admin.js";
import { ensureStorage, loadConfig, loadSnapshots, saveConfig } from "./store.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const adminApiEnabled = process.env.PAGE_SHOT_ADMIN === "1";
const snapshotDeleteEnabled = true;

let config = await loadConfig();
let captureState = {
  running: false,
  startedAt: null,
  lastFinishedAt: null,
  lastResults: []
};
let scheduleTimer = null;
let nextRunAt = null;

await ensureStorage();
scheduleNext();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/state") {
      return sendJson(response, await buildState());
    }

    if (request.method === "GET" && pathname === "/api/changes") {
      return sendJson(response, annotateChangesForResponse(await loadChanges(), config));
    }

    if (request.method === "POST" && pathname === "/api/capture-issues") {
      const body = await readJsonBody(request);
      const issue = await markCaptureTileIssue(body);
      return sendJson(response, {
        ok: true,
        issue,
        state: await buildState()
      });
    }

    if (request.method === "POST" && pathname === "/api/capture") {
      if (!adminApiEnabled) {
        return rejectViewerMode(response);
      }
      const body = await readJsonBody(request);
      const result = await runCapture({
        url: body.url || null,
        allDevices: Boolean(body.allDevices),
        platform: stringOrNull(body.platform),
        planIds: Array.isArray(body.planIds) ? body.planIds : null
      });
      return sendJson(response, result, result.ok ? 200 : 409);
    }

    if (request.method === "POST" && pathname === "/api/config") {
      if (!adminApiEnabled) {
        return rejectViewerMode(response);
      }
      const body = await readJsonBody(request);
      config = await saveConfig({
        ...config,
        ...body
      });
      scheduleNext();
      return sendJson(response, await buildState());
    }

    if (request.method === "DELETE" && pathname.startsWith("/api/snapshots/")) {
      const snapshotId = decodeURIComponent(pathname.slice("/api/snapshots/".length));
      const result = await deleteSnapshotAction({
        canDeleteSnapshots: snapshotDeleteEnabled,
        captureRunning: captureState.running,
        snapshotId,
        buildState
      });
      return sendJson(response, result.payload, result.status);
    }

    if (request.method === "GET" && pathname.startsWith("/preview/")) {
      return servePreview(url, response);
    }

    if (request.method === "GET" && pathname.startsWith("/archive/")) {
      return serveArchive(url, response);
    }

    if (request.method === "GET") {
      return servePublic(url, response);
    }

    return sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    return sendJson(response, { error: error.message }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Page Shot Archive is running at http://${host}:${port}`);
  console.log(`Configured targets: ${config.targets.map((target) => target.url).join(", ")}`);
});

async function runCapture(options = {}) {
  if (captureState.running) {
    scheduleNext();
    return { ok: false, error: "A capture is already running." };
  }

  const allDevices = Boolean(options.allDevices);

  captureState = {
    ...captureState,
    running: true,
    startedAt: new Date().toISOString(),
    lastResults: [],
    allDevices
  };

  try {
    const results = allDevices
      ? await captureAllDevices(config, {
        platform: options.platform,
        planIds: options.planIds
      })
      : options.url
        ? [await captureOne(options.url, config, {
          platform: options.platform,
          planIds: options.planIds
        })]
        : await captureConfiguredUrls(config, {
          platform: options.platform,
          planIds: options.planIds
        });
    captureState.lastResults = results;
    return { ok: true, results, state: await buildState() };
  } finally {
    captureState.running = false;
    captureState.lastFinishedAt = new Date().toISOString();
    scheduleNext();
  }
}

function scheduleNext() {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
  }
  scheduleTimer = null;
  nextRunAt = null;

  const intervalMinutes = Number(config.intervalMinutes);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return;
  }

  const delay = Math.max(1000, intervalMinutes * 60 * 1000);
  const next = new Date(Date.now() + delay);
  nextRunAt = next.toISOString();
  scheduleTimer = setTimeout(async () => {
    const result = await runCapture({ allDevices: true }).catch((error) => {
      captureState.lastResults = [{ ok: false, error: error.message }];
      return { ok: false };
    });
    if (!result.ok) {
      scheduleNext();
    }
  }, delay);
}

async function buildState() {
  const [changes, snapshots, browser, captureIssues] = await Promise.all([
    loadChanges(),
    loadSnapshots(),
    browserStatus(),
    loadCaptureIssues()
  ]);
  return buildStatePayload({
    config,
    captureState,
    nextRunAt,
    browser,
    snapshots,
    changes,
    captureIssues,
    permissions: {
      canDeleteSnapshots: snapshotDeleteEnabled
    }
  });
}

async function servePublic(url, response) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = safeJoin(publicDir, pathname);
  if (!filePath) {
    return sendStatus(response, 403);
  }
  return sendFile(response, filePath, { cacheControl: "no-store" });
}

async function serveArchive(url, response) {
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/archive\//, ""));
  const filePath = safeJoin(archiveDir, relativePath);
  if (!filePath) {
    return sendStatus(response, 403);
  }
  return sendFile(response, filePath);
}

async function servePreview(url, response) {
  const snapshot = await previewSnapshotForRequest(url);
  if (!snapshot) {
    return sendHtml(response, renderPreviewErrorPage({
      title: "Snapshot not found",
      message: "No matching archived screenshot was found for this preview request."
    }), 404, { cacheControl: "no-store" });
  }

  const filePath = safeJoin(archiveDir, snapshot.file || "");
  if (!filePath) {
    return sendHtml(response, renderPreviewErrorPage({
      title: "Snapshot unavailable",
      message: "The archived screenshot path is missing or invalid."
    }), 404, { cacheControl: "no-store" });
  }

  try {
    const content = await fs.readFile(filePath);
    return sendHtml(response, renderSnapshotPreviewPage(snapshot, filePath, content), 200, {
      cacheControl: "no-store"
    });
  } catch {
    return sendHtml(response, renderPreviewErrorPage({
      title: "Snapshot file missing",
      message: "The archived screenshot metadata exists, but the image file could not be read."
    }), 404, { cacheControl: "no-store" });
  }
}

async function previewSnapshotForRequest(url) {
  const snapshots = await loadSnapshots();
  if (url.pathname === "/preview/snapshot") {
    const snapshotId = url.searchParams.get("id");
    return snapshots.find((snapshot) => snapshot.id === snapshotId) || null;
  }

  if (url.pathname === "/preview/latest") {
    const targetId = stringOrNull(url.searchParams.get("targetId"));
    const devicePresetId = stringOrNull(url.searchParams.get("devicePresetId"));
    const requestedUrl = normalizePreviewUrl(url.searchParams.get("url"));

    return snapshots.find((snapshot) => {
      if (targetId && snapshot.targetId !== targetId) {
        return false;
      }
      if (devicePresetId && snapshot.devicePresetId !== devicePresetId) {
        return false;
      }
      if (!requestedUrl) {
        return true;
      }
      const candidates = [
        snapshot.url,
        snapshot.requestedUrl,
        snapshot.finalUrl
      ].map(normalizePreviewUrl).filter(Boolean);
      return candidates.includes(requestedUrl);
    }) || null;
  }

  return null;
}

async function sendFile(response, filePath, options = {}) {
  try {
    const content = await fs.readFile(filePath);
    const headers = { "Content-Type": contentType(filePath) };
    if (options.cacheControl) {
      headers["Cache-Control"] = options.cacheControl;
    }
    response.writeHead(200, headers);
    response.end(content);
  } catch {
    sendStatus(response, 404);
  }
}

function sendHtml(response, html, status = 200, options = {}) {
  const headers = { "Content-Type": "text/html; charset=utf-8" };
  if (options.cacheControl) {
    headers["Cache-Control"] = options.cacheControl;
  }
  response.writeHead(status, headers);
  response.end(html);
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendStatus(response, status) {
  response.writeHead(status);
  response.end();
}

function rejectViewerMode(response) {
  return sendJson(response, {
    error: viewerModeErrorMessage
  }, 403);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function renderSnapshotPreviewPage(snapshot, filePath, content) {
  const mimeType = contentType(filePath).split(";")[0];
  const imageUrl = `data:${mimeType};base64,${content.toString("base64")}`;
  const title = escapeHtml(snapshot.displayUrl || snapshot.targetLabel || snapshot.url || "Archived Screenshot");
  const capturedAt = escapeHtml(formatPreviewDate(snapshot.capturedAt));
  const deviceName = escapeHtml(snapshot.deviceName || snapshot.devicePresetId || "Unknown device");
  const dimensions = snapshot.width && snapshot.height ? `${snapshot.width}x${snapshot.height}` : "Unknown size";
  const metaLines = [
    { label: "Captured", value: capturedAt },
    { label: "Device", value: deviceName },
    { label: "Size", value: escapeHtml(dimensions) },
    { label: "Target", value: escapeHtml(snapshot.targetId || "N/A") }
  ];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #eef3f8;
        --panel: rgba(255, 255, 255, 0.94);
        --border: rgba(18, 42, 66, 0.14);
        --text: #102235;
        --muted: #5d6f82;
        --shadow: 0 24px 60px rgba(21, 41, 63, 0.14);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(87, 150, 255, 0.18), transparent 26%),
          radial-gradient(circle at top right, rgba(32, 182, 153, 0.16), transparent 24%),
          linear-gradient(180deg, #f6f9fc 0%, var(--bg) 100%);
      }
      main {
        width: min(980px, calc(100vw - 32px));
        margin: 24px auto;
        display: grid;
        gap: 16px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }
      .hero {
        padding: 20px;
      }
      .eyebrow {
        margin: 0 0 6px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      h1 {
        margin: 0;
        font-size: clamp(24px, 3vw, 34px);
        line-height: 1.1;
      }
      .meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 12px;
        margin-top: 16px;
      }
      .meta-card {
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(245, 248, 252, 0.96);
        border: 1px solid rgba(18, 42, 66, 0.08);
      }
      .meta-card span {
        display: block;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .meta-card strong {
        display: block;
        margin-top: 8px;
        font-size: 14px;
        line-height: 1.4;
        word-break: break-word;
      }
      .image-shell {
        padding: 14px;
      }
      .image-frame {
        overflow: auto;
        max-height: calc(100vh - 240px);
        border-radius: 18px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, #fff, #f7fbff);
        padding: 10px;
      }
      img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 12px;
        background: #fff;
      }
      @media (max-width: 640px) {
        main {
          width: calc(100vw - 16px);
          margin: 8px auto 16px;
        }
        .hero {
          padding: 16px;
        }
        .image-shell {
          padding: 10px;
        }
        .image-frame {
          max-height: calc(100vh - 220px);
          padding: 8px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel hero">
        <p class="eyebrow">In-App Preview</p>
        <h1>${title}</h1>
        <div class="meta">
          ${metaLines.map((line) => `
            <div class="meta-card">
              <span>${escapeHtml(line.label)}</span>
              <strong>${line.value}</strong>
            </div>
          `).join("")}
        </div>
      </section>
      <section class="panel image-shell">
        <div class="image-frame">
          <img src="${imageUrl}" alt="${title}">
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderPreviewErrorPage({ title, message }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #f6f9fc 0%, #eaf0f6 100%);
        color: #13263a;
      }
      article {
        width: min(560px, 100%);
        padding: 28px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(19, 38, 58, 0.1);
        box-shadow: 0 24px 60px rgba(21, 41, 63, 0.12);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      p {
        margin: 0;
        line-height: 1.6;
        color: #55677a;
      }
    </style>
  </head>
  <body>
    <article>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
    </article>
  </body>
</html>`;
}

function normalizePreviewUrl(value) {
  const raw = stringOrNull(value);
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function formatPreviewDate(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false })
    : "Unknown time";
}

function stringOrNull(value) {
  const string = String(value || "").trim();
  return string || null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
