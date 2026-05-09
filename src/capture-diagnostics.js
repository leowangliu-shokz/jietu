import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logsDir } from "./paths.js";

const diagnosticsJsonlPath = path.join(logsDir, "capture-diagnostics.jsonl");
const diagnosticsRunsDir = path.join(logsDir, "captures");

export function createCaptureDiagnosticRun(context = {}) {
  return {
    id: `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    context: normalizeJson(context),
    events: []
  };
}

export function recordCaptureDiagnostic(run, event = {}) {
  if (!run || typeof run !== "object") {
    return run;
  }
  run.events.push({
    at: new Date().toISOString(),
    ...normalizeJson(event)
  });
  return run;
}

export async function finalizeCaptureDiagnostic(run, summary = {}) {
  if (!run || typeof run !== "object") {
    return null;
  }
  const finishedAt = new Date().toISOString();
  const payload = {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt,
    context: normalizeJson(run.context),
    summary: normalizeJson(summary),
    events: normalizeJson(run.events)
  };

  await fs.mkdir(diagnosticsRunsDir, { recursive: true });
  await fs.appendFile(diagnosticsJsonlPath, `${JSON.stringify({
    id: payload.id,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
    context: payload.context,
    summary: payload.summary
  })}\n`, "utf8");
  await fs.writeFile(path.join(diagnosticsRunsDir, `${payload.id}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function normalizeJson(value) {
  return JSON.parse(JSON.stringify(value, (_, current) => {
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack
      };
    }
    return current;
  }));
}
