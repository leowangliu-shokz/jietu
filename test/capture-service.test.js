import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __testOnly, relatedShotLabelForCaptureItem } from "../src/capture-service.js";

test("uses the state label for product showcase capture items", () => {
  const label = relatedShotLabelForCaptureItem({
    sectionKey: "product-showcase",
    stateLabel: "Best Selling 1",
    label: "轮播 undefined"
  });

  assert.equal(label, "Best Selling 1");
});

test("finds related screenshots by preview file for replacement", () => {
  const snapshot = {
    relatedShots: [
      { file: "2026-05-15/shokz/home.png", sectionKey: "banner" },
      { file: "2026-05-15/shokz/collection-tabs-all.png", sectionKey: "collection-tabs" }
    ]
  };

  const match = __testOnly.findRelatedShotForReplacement(snapshot, {
    previewFile: "2026-05-15/shokz/collection-tabs-all.png",
    tileKey: "whole:collection-tabs-all"
  });

  assert.equal(match?.shot.sectionKey, "collection-tabs");
});

test("finds composite related screenshots by source tile file", () => {
  const snapshot = {
    relatedShots: [{
      file: "2026-05-15/shokz/product-map.png",
      sectionKey: "product-showcase",
      composite: {
        variants: [{
          key: "product-showcase:best-selling:1",
          sourceFile: "2026-05-15/shokz/product-showcase-best-selling-1.png"
        }]
      }
    }]
  };

  const match = __testOnly.findRelatedShotForReplacement(snapshot, {
    sourceFile: "2026-05-15/shokz/product-showcase-best-selling-1.png",
    tileKey: "product-showcase:best-selling:1"
  });

  assert.equal(match?.shot.file, "2026-05-15/shokz/product-map.png");
});

test("resolves replacement capture modes for non-home related screenshots", () => {
  assert.equal(
    __testOnly.relatedReplacementCaptureMode(
      { targetId: "shokz-products-nav", captureMode: "shokz-products-nav" },
      { sectionKey: "navigation" },
      {}
    ),
    "shokz-products-nav-related"
  );

  assert.equal(
    __testOnly.relatedReplacementCaptureMode(
      { captureMode: "shokz-collection-page" },
      { sectionKey: "collection-tabs" },
      {}
    ),
    "shokz-collection-related-section"
  );

  assert.equal(
    __testOnly.relatedReplacementCaptureMode(
      { captureMode: "shokz-comparison-page" },
      { sectionKey: "comparison-quick-look" },
      {}
    ),
    "shokz-comparison-related-section"
  );

  assert.equal(
    __testOnly.relatedReplacementCaptureMode(
      { captureMode: "shokz-landing-page" },
      { sectionKey: "landing-open-ear-benefits" },
      {}
    ),
    "shokz-landing-related"
  );
});

test("network preflight retries capture target and DingTalk checks before succeeding", async () => {
  const plans = [{
    id: "plan-home-pc",
    platform: "pc",
    target: {
      id: "home",
      label: "Home",
      url: "https://shokz.com/"
    }
  }];
  let attempt = 0;

  const result = await __testOnly.runCaptureNetworkPreflight(plans, {}, {
    env: {
      CHANGE_NOTIFY_ENABLED: "1",
      DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=test"
    },
    networkPreflightAttempts: 3,
    networkPreflightRetryDelayMs: 0,
    networkPreflightSleep: async () => {},
    networkPreflightProbe: async (check) => {
      if (check.type === "capture-target") {
        attempt += 1;
      }
      return attempt >= 2
        ? { ok: true, status: 200 }
        : { ok: false, error: "offline" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.checks.map((check) => check.type), ["capture-target", "dingtalk-webhook"]);
});

test("network preflight continues when DingTalk is unavailable but capture target is reachable", async () => {
  const plans = [{
    id: "plan-home-pc",
    platform: "pc",
    target: {
      id: "home",
      label: "Home",
      url: "https://shokz.com/"
    }
  }];

  const result = await __testOnly.runCaptureNetworkPreflight(plans, {}, {
    env: {
      CHANGE_NOTIFY_ENABLED: "1",
      DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=test"
    },
    networkPreflightAttempts: 3,
    networkPreflightRetryDelayMs: 0,
    networkPreflightSleep: async () => {},
    networkPreflightProbe: async (check) => check.type === "capture-target"
      ? { ok: true, status: 200 }
      : { ok: false, error: "connect timeout" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.warning, true);
  assert.equal(result.attempts, 1);
  assert.match(result.message, /non-blocking failures/);
});

test("network preflight treats direct connect EACCES as a warning when DNS resolves", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-network-preflight-warning-"));
  const diagnosticsFilePath = path.join(dir, "network-preflight-diagnostics.jsonl");
  const plans = [{
    id: "plan-home-pc",
    platform: "pc",
    target: {
      id: "home",
      label: "Home",
      url: "https://shokz.com/"
    }
  }];

  const result = await __testOnly.runCaptureNetworkPreflight(plans, {}, {
    networkPreflightAttempts: 1,
    networkPreflightRetryDelayMs: 0,
    networkPreflightDiagnosticsFilePath: diagnosticsFilePath,
    networkPreflightProbe: async () => ({
      ok: false,
      error: "fetch failed",
      errorDetails: {
        name: "TypeError",
        message: "fetch failed",
        cause: { code: "EACCES", syscall: "connect" }
      }
    }),
    networkPreflightDiagnosticsProbe: async (checks) => ({
      id: "diag-warning-test",
      environment: {
        wlan: { parsed: { ssid: "SHOKZ_Office" } },
        networkInterfaces: [{ name: "WLAN", address: "10.42.147.215", family: "IPv4" }]
      },
      checks: checks.map((check) => ({
        type: check.type,
        label: check.label,
        url: check.url,
        fetch: { errorDetails: check.errorDetails },
        dns: { ok: true, lookup: [{ address: "23.227.38.74", family: 4 }] },
        tcp443: { ok: false, errorDetails: { code: "EACCES" } },
        curlHead: { ok: false, exitCode: 7, stderr: "Could not connect to server" }
      }))
    })
  });
  const lines = (await fs.readFile(diagnosticsFilePath, "utf8")).trim().split(/\r?\n/);
  const stored = JSON.parse(lines[0]);

  assert.equal(result.ok, true);
  assert.equal(result.warning, true);
  assert.equal(result.diagnostics.id, "diag-warning-test");
  assert.equal(stored.checks[0].dns.lookup[0].address, "23.227.38.74");
  assert.equal(stored.checks[0].curlHead.exitCode, 7);
  await fs.rm(dir, { recursive: true, force: true });
});

test("network preflight hard DNS failure records diagnostics and low-level error details", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-network-preflight-"));
  const diagnosticsFilePath = path.join(dir, "network-preflight-diagnostics.jsonl");
  const plans = [{
    id: "plan-home-pc",
    platform: "pc",
    target: {
      id: "home",
      label: "Home",
      url: "https://shokz.com/"
    }
  }];

  const result = await __testOnly.runCaptureNetworkPreflight(plans, {}, {
    networkPreflightAttempts: 1,
    networkPreflightRetryDelayMs: 0,
    networkPreflightDiagnosticsFilePath: diagnosticsFilePath,
    networkPreflightProbe: async () => ({
      ok: false,
      error: "fetch failed",
      errorDetails: {
        name: "TypeError",
        message: "fetch failed",
        cause: { code: "ENOTFOUND", syscall: "getaddrinfo" }
      }
    }),
    networkPreflightDiagnosticsProbe: async (checks) => ({
      id: "diag-test",
      environment: {
        wlan: { parsed: { ssid: "SHOKZ_Office" } },
        networkInterfaces: [{ name: "WLAN", address: "10.42.147.215", family: "IPv4" }]
      },
      checks: checks.map((check) => ({
        type: check.type,
        label: check.label,
        url: check.url,
        fetch: { errorDetails: check.errorDetails },
        dns: { ok: false, lookupError: { code: "ENOTFOUND", syscall: "getaddrinfo" } },
        tcp443: { ok: false, errorDetails: { code: "ENOTFOUND" } },
        curlHead: { ok: false, exitCode: 6, stderr: "Could not resolve host" }
      }))
    })
  });
  const lines = (await fs.readFile(diagnosticsFilePath, "utf8")).trim().split(/\r?\n/);
  const stored = JSON.parse(lines[0]);

  assert.equal(result.ok, false);
  assert.equal(result.checks[0].errorDetails.cause.code, "ENOTFOUND");
  assert.equal(result.diagnostics.id, "diag-test");
  assert.equal(stored.environment.wlan.parsed.ssid, "SHOKZ_Office");
  assert.equal(stored.checks[0].dns.lookupError.code, "ENOTFOUND");
  assert.equal(stored.checks[0].curlHead.exitCode, 6);
  await fs.rm(dir, { recursive: true, force: true });
});

test("network preflight skip records a skipped run without failed items", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jietu-capture-runs-"));
  const captureRunsFilePath = path.join(dir, "capture-runs.json");
  const plans = [{
    id: "plan-home-pc",
    platform: "pc",
    deviceProfileId: "pc-default",
    deviceProfile: { id: "pc-default", devicePresetId: "pc-hd" },
    target: {
      id: "home",
      label: "Home",
      url: "https://shokz.com/"
    }
  }];
  const results = await __testOnly.skipCaptureRunForNetworkPreflight(plans, {}, {
    runId: "run-network-skip",
    captureRunsFilePath
  }, {
    ok: false,
    reason: "network-unavailable",
    message: "Network preflight failed; capture skipped.",
    checks: [{ type: "capture-target", label: "shokz.com", ok: false, error: "offline" }]
  });
  const storedRuns = JSON.parse(await fs.readFile(captureRunsFilePath, "utf8"));

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].skipped, true);
  assert.equal(results.captureRun.status, "skipped");
  assert.equal(results.captureRun.failureCount, 0);
  assert.equal(results.captureRun.skippedCount, 1);
  assert.equal(storedRuns[0].status, "skipped");
  assert.equal(storedRuns[0].items[0].status, "skipped");
  assert.equal(storedRuns[0].items[0].ok, null);
  await fs.rm(dir, { recursive: true, force: true });
});
