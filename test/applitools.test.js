import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  applitoolsConfigFromEnv,
  compareWithApplitoolsImages,
  normalizeApplitoolsResponse
} from "../src/vision/applitools.js";

test("applitoolsConfigFromEnv is disabled without an API key", () => {
  assert.equal(applitoolsConfigFromEnv({}), null);
});

test("applitoolsConfigFromEnv reads non-secret runtime settings", () => {
  const config = applitoolsConfigFromEnv({
    APPLITOOLS_API_KEY: "test-key",
    APPLITOOLS_APP_NAME: "jietu-test",
    APPLITOOLS_BATCH_NAME: "batch-test",
    APPLITOOLS_BRANCH_NAME: "branch-test",
    APPLITOOLS_MATCH_LEVEL: "Layout"
  });

  assert.equal(config.provider, "applitools");
  assert.equal(config.apiKey, "test-key");
  assert.equal(config.appName, "jietu-test");
  assert.equal(config.batchName, "batch-test");
  assert.equal(config.branchName, "branch-test");
  assert.equal(config.matchLevel, "Layout");
});

test("compareWithApplitoolsImages uploads the current screenshot through Eyes", async () => {
  const calls = [];
  const fakeEyes = {
    setApiKey: (value) => calls.push(["setApiKey", value]),
    setAppName: (value) => calls.push(["setAppName", value]),
    setTestName: (value) => calls.push(["setTestName", value]),
    setBatch: (value) => calls.push(["setBatch", value]),
    setBranchName: (value) => calls.push(["setBranchName", value]),
    setMatchLevel: (value) => calls.push(["setMatchLevel", value]),
    setHostApp: (value) => calls.push(["setHostApp", value]),
    setHostOS: (value) => calls.push(["setHostOS", value]),
    open: async () => calls.push(["open"]),
    checkImage: async (imagePath, name) => {
      calls.push(["checkImage", imagePath, name]);
      return { asExpected: false };
    },
    close: async () => ({
      status: "Unresolved",
      isDifferent: true,
      isNew: false,
      mismatches: 1,
      missing: 0,
      appUrls: { session: "https://eyes.example.test/session" }
    })
  };

  const result = await compareWithApplitoolsImages({}, {
    file: "2026-06-16/example/current.png",
    targetId: "example-home",
    platform: "pc",
    deviceProfileId: "pc-default",
    itemKind: "page",
    sectionKey: "page",
    positionKey: "page",
    displayUrl: "Example",
    width: 1200,
    height: 2400
  }, {
    apiKey: "test-key",
    appName: "jietu-test",
    batchName: "batch-test",
    branchName: "main",
    matchLevel: "Strict",
    archiveRoot: "D:\\archive",
    eyesFactory: () => fakeEyes
  });

  assert.equal(result.changed, true);
  assert.equal(result.provider, "applitools");
  assert.equal(result.dashboardUrl, "https://eyes.example.test/session");
  assert.deepEqual(calls[0], ["setApiKey", "test-key"]);
  assert.ok(calls.some((call) => call[0] === "checkImage" && call[1] === path.join("D:\\archive", "2026-06-16/example/current.png")));
});

test("normalizeApplitoolsResponse does not treat first baseline creation as a jietu change by default", () => {
  const result = normalizeApplitoolsResponse({
    match: { asExpected: false },
    results: {
      status: "Unresolved",
      isNew: true,
      isDifferent: false,
      mismatches: 0,
      missing: 0
    }
  });

  assert.equal(result.changed, false);
  assert.equal(result.isNew, true);
});

test("normalizeApplitoolsResponse can mark new baselines as changes when requested", () => {
  const result = normalizeApplitoolsResponse({
    match: { asExpected: false },
    results: {
      status: "Unresolved",
      isNew: true,
      isDifferent: false,
      mismatches: 0,
      missing: 0
    },
    config: { recordNewBaselinesAsChanges: true }
  });

  assert.equal(result.changed, true);
});
