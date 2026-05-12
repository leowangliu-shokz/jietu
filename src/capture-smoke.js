import { captureAllDevices, captureConfiguredUrls, captureOne } from "./capture-service.js";
import { loadConfig } from "./store.js";

const args = parseArgs(process.argv.slice(2));
const allowWarnings = args.has("--allow-warnings");
const allDevices = args.has("--all-devices");
const targetId = args.get("--target-id");
const url = args.get("--url");
const devicePresetId = args.get("--device-preset-id");

const config = await loadConfig();

const results = await runCaptures({
  config,
  allDevices,
  targetId,
  url
});

const summary = summarizeResults(results);
console.log(JSON.stringify(summary, null, 2));

if (
  summary.failures.length ||
  summary.lowConfidence.length ||
  (!allowWarnings && summary.warnings.length)
) {
  process.exitCode = 1;
}

async function runCaptures({ config, allDevices, targetId, url }) {
  if (url) {
    return [await captureOne(url, config, {
      ...(devicePresetId ? { devicePresetId } : {})
    })];
  }

  const filters = {
    ...(targetId ? { targetId } : {}),
    ...(devicePresetId ? { devicePresetId } : {})
  };
  const results = allDevices
    ? await captureAllDevices(config, filters)
    : await captureConfiguredUrls(config, filters);

  if (targetId && results.length === 0) {
    throw new Error(`Unknown target id: ${targetId}`);
  }

  return results;
}

function summarizeResults(results) {
  const failures = [];
  const warnings = [];
  const lowConfidence = [];
  const captures = [];

  for (const result of results) {
    if (!result?.ok) {
      failures.push({
        targetId: result?.targetId || null,
        url: result?.url || result?.requestedUrl || null,
        error: result?.error || "Capture failed."
      });
      continue;
    }

    const snapshots = Array.isArray(result.snapshots) && result.snapshots.length
      ? result.snapshots
      : result.snapshot
        ? [result.snapshot]
        : [];

    for (const snapshot of snapshots) {
      captures.push({
        targetId: snapshot.targetId,
        capturedAt: snapshot.capturedAt,
        file: snapshot.file,
        relatedShotCount: Array.isArray(snapshot.relatedShots) ? snapshot.relatedShots.length : 0
      });

      if (snapshot.captureConfidence?.baselineEligible === false) {
        lowConfidence.push({
          targetId: snapshot.targetId,
          file: snapshot.file,
          reasons: snapshot.captureConfidence.reasons || []
        });
      }

      for (const shot of snapshot.relatedShots || []) {
        if (shot.captureConfidence?.baselineEligible === false) {
          lowConfidence.push({
            targetId: snapshot.targetId,
            file: shot.file,
            sectionKey: shot.sectionKey,
            stateLabel: shot.stateLabel || shot.label || null,
            reasons: shot.captureConfidence.reasons || []
          });
        }
      }

      for (const warning of snapshot.relatedValidation?.warnings || []) {
        warnings.push({
          targetId: snapshot.targetId,
          sectionKey: warning.sectionKey || null,
          stateLabel: warning.stateLabel || null,
          message: warning.message || "Capture warning"
        });
      }
    }
  }

  return {
    captures,
    failures,
    warnings,
    lowConfidence
  };
}

function parseArgs(argv) {
  const map = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      map.set(key, true);
      continue;
    }
    map.set(key, next);
    index += 1;
  }
  return map;
}
