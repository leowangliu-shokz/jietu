import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { captureAllDevices, captureConfiguredUrls, captureOne, browserStatus } from "./capture-service.js";
import { devicePresets, toPublicDevicePreset } from "./device-presets.js";
import { archiveDir, publicDir } from "./paths.js";
import { ensureStorage, loadConfig, loadSnapshots, saveConfig } from "./store.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);

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
    if (request.method === "GET" && request.url === "/api/state") {
      return sendJson(response, await buildState());
    }

    if (request.method === "POST" && request.url === "/api/capture") {
      const body = await readJsonBody(request);
      const result = await runCapture({
        url: body.url || null,
        allDevices: Boolean(body.allDevices),
        runSource: body.runSource === "auto" ? "auto" : "manual"
      });
      return sendJson(response, result, result.ok ? 200 : 409);
    }

    if (request.method === "POST" && request.url === "/api/config") {
      const body = await readJsonBody(request);
      config = await saveConfig({
        ...config,
        ...body
      });
      scheduleNext();
      return sendJson(response, await buildState());
    }

    if (request.method === "GET" && request.url?.startsWith("/archive/")) {
      return serveArchive(request, response);
    }

    if (request.method === "GET") {
      return servePublic(request, response);
    }

    return sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    return sendJson(response, { error: error.message }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Page Shot Archive is running at http://${host}:${port}`);
  console.log(`Default URL: ${config.urls.join(", ")}`);
});

async function runCapture(options = {}) {
  if (captureState.running) {
    scheduleNext();
    return { ok: false, error: "A capture is already running." };
  }

  const runSource = options.runSource === "auto" ? "auto" : "manual";
  const allDevices = Boolean(options.allDevices);

  captureState = {
    ...captureState,
    running: true,
    startedAt: new Date().toISOString(),
    lastResults: [],
    runSource,
    allDevices
  };

  try {
    const results = allDevices
      ? await captureAllDevices(config, { runSource })
      : options.url
        ? [await captureOne(options.url, config, { runSource })]
        : await captureConfiguredUrls(config, { runSource });
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

  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  const delay = Math.max(1000, next.getTime() - Date.now());
  nextRunAt = next.toISOString();
  scheduleTimer = setTimeout(async () => {
    const result = await runCapture({ allDevices: true, runSource: "auto" }).catch((error) => {
      captureState.lastResults = [{ ok: false, error: error.message }];
      return { ok: false };
    });
    if (!result.ok) {
      scheduleNext();
    }
  }, delay);
}

async function buildState() {
  return {
    config,
    capture: captureState,
    nextRunAt,
    browser: await browserStatus(),
    devicePresets: devicePresets.map(toPublicDevicePreset),
    snapshots: await loadSnapshots()
  };
}

async function servePublic(request, response) {
  const url = new URL(request.url, `http://${host}:${port}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = safeJoin(publicDir, pathname);
  if (!filePath) {
    return sendStatus(response, 403);
  }
  return sendFile(response, filePath);
}

async function serveArchive(request, response) {
  const url = new URL(request.url, `http://${host}:${port}`);
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/archive\//, ""));
  const filePath = safeJoin(archiveDir, relativePath);
  if (!filePath) {
    return sendStatus(response, 403);
  }
  return sendFile(response, filePath);
}

function safeJoin(root, requestedPath) {
  const cleanPath = requestedPath.replace(/^[/\\]+/, "");
  const resolved = path.resolve(root, cleanPath);
  const rootResolved = path.resolve(root);
  return resolved.startsWith(rootResolved) ? resolved : null;
}

async function sendFile(response, filePath) {
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(content);
  } catch {
    sendStatus(response, 404);
  }
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendStatus(response, status) {
  response.writeHead(status);
  response.end();
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
