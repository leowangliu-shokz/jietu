import path from "node:path";
import { archiveDir } from "../paths.js";

const defaultAppName = "jietu";
const defaultBatchName = "jietu-hourly";
const defaultBranchName = "main";
const defaultMatchLevel = "Strict";

export function applitoolsConfigFromEnv(env = process.env) {
  const apiKey = cleanText(env.APPLITOOLS_API_KEY);
  if (!apiKey) {
    return null;
  }
  return {
    provider: "applitools",
    apiKey,
    appName: cleanText(env.APPLITOOLS_APP_NAME) || defaultAppName,
    batchName: cleanText(env.APPLITOOLS_BATCH_NAME) || defaultBatchName,
    branchName: cleanText(env.APPLITOOLS_BRANCH_NAME) || defaultBranchName,
    matchLevel: cleanText(env.APPLITOOLS_MATCH_LEVEL) || defaultMatchLevel,
    serverUrl: cleanText(env.APPLITOOLS_SERVER_URL) || null,
    recordNewBaselinesAsChanges: booleanOption(env.APPLITOOLS_RECORD_NEW_BASELINES_AS_CHANGES, false),
    timeoutMs: Number(env.APPLITOOLS_TIMEOUT_MS || 60000)
  };
}

export async function compareWithApplitoolsImages(fromItem, toItem, config = {}) {
  const apiKey = cleanText(config.apiKey || process.env.APPLITOOLS_API_KEY);
  if (!apiKey) {
    throw new Error("APPLITOOLS_API_KEY is required for Applitools visual compare");
  }

  const imagePath = path.join(config.archiveRoot || archiveDir, toItem.file || "");
  const EyesClass = config.EyesClass || (await import("@applitools/eyes-images")).Eyes;
  const eyes = config.eyesFactory ? config.eyesFactory() : new EyesClass();
  configureEyes(eyes, {
    ...config,
    apiKey,
    testName: config.testName || applitoolsTestNameForItem(toItem),
    hostApp: config.hostApp || `${toItem.platform || "web"} screenshot`,
    hostOS: config.hostOS || toItem.deviceProfileId || toItem.deviceId || "jietu"
  });

  let opened = false;
  try {
    await eyes.open();
    opened = true;
    const match = await eyes.checkImage(imagePath, applitoolsStepNameForItem(toItem), false);
    const results = await eyes.close(false);
    return normalizeApplitoolsResponse({ match, results, fromItem, toItem, config });
  } catch (error) {
    if (opened && typeof eyes.abortIfNotClosed === "function") {
      await eyes.abortIfNotClosed().catch(() => null);
    } else if (typeof eyes.abort === "function") {
      await eyes.abort().catch(() => null);
    }
    throw error;
  }
}

export function normalizeApplitoolsResponse({ match = {}, results = {}, toItem = {}, config = {} } = {}) {
  const status = resultValue(results, "getStatus", "status") || "Unknown";
  const isNew = Boolean(resultValue(results, "getIsNew", "isNew"));
  const isDifferent = Boolean(resultValue(results, "getIsDifferent", "isDifferent"));
  const mismatches = Number(resultValue(results, "getMismatches", "mismatches") || 0);
  const missing = Number(resultValue(results, "getMissing", "missing") || 0);
  const asExpected = resultValue(match, "getAsExpected", "asExpected");
  const appUrls = resultValue(results, "getAppUrls", "appUrls") || {};
  const stepsInfo = resultValue(results, "getStepsInfo", "stepsInfo") || [];
  const dashboardUrl = cleanText(resultValue(results, "getUrl", "url")) ||
    cleanText(appUrls.session) ||
    cleanText(appUrls.batch);
  const newBaselineIsChange = Boolean(config.recordNewBaselinesAsChanges);
  const changed = isNew
    ? newBaselineIsChange
    : isDifferent || mismatches > 0 || missing > 0 || status === "Failed" || asExpected === false;

  return {
    provider: "applitools",
    changed,
    judgment: isNew ? "applitools-new-baseline" : "applitools-visual-ai",
    summary: applitoolsSummary({ status, isNew, isDifferent, mismatches, missing, changed }),
    diffImageUrl: dashboardUrl || null,
    regions: [],
    changedPixels: 0,
    rawChangedPixels: 0,
    comparedPixels: 0,
    ratio: changed ? 1 : 0,
    width: Number(toItem.width || 0) || null,
    height: Number(toItem.height || 0) || null,
    dimensionChanged: false,
    signals: changed
      ? [{ type: "applitools", label: `Applitools ${status}`, url: dashboardUrl || null }]
      : [],
    confidence: status === "Passed" ? 1 : null,
    status,
    isNew,
    isDifferent,
    mismatches,
    missing,
    dashboardUrl: dashboardUrl || null,
    batchUrl: cleanText(appUrls.batch) || null,
    sessionUrl: cleanText(appUrls.session) || null,
    stepsInfo: normalizeStepsInfo(stepsInfo)
  };
}

function configureEyes(eyes, config = {}) {
  callIfExists(eyes, "setApiKey", config.apiKey);
  callIfExists(eyes, "setAppName", cleanText(config.appName) || defaultAppName);
  callIfExists(eyes, "setTestName", cleanText(config.testName) || "jietu visual compare");
  callIfExists(eyes, "setBatch", cleanText(config.batchName) || defaultBatchName);
  callIfExists(eyes, "setBranchName", cleanText(config.branchName) || defaultBranchName);
  callIfExists(eyes, "setMatchLevel", cleanText(config.matchLevel) || defaultMatchLevel);
  callIfExists(eyes, "setHostApp", cleanText(config.hostApp) || "jietu screenshot");
  callIfExists(eyes, "setHostOS", cleanText(config.hostOS) || "jietu");
  if (config.serverUrl) {
    callIfExists(eyes, "setServerUrl", config.serverUrl);
  }
}

function applitoolsTestNameForItem(item = {}) {
  return [
    item.targetId || item.displayUrl || item.url || "target",
    item.platform || "web",
    item.deviceProfileId || item.deviceId || "device",
    item.itemKind || "page",
    item.sectionKey || "page",
    item.positionKey || "default"
  ].map(cleanNamePart).join(" / ");
}

function applitoolsStepNameForItem(item = {}) {
  return [
    item.displayUrl || item.targetLabel || item.url || "Page",
    item.sectionLabel || item.sectionKey || "",
    item.label || item.stateLabel || ""
  ].map(cleanText).filter(Boolean).join(" - ") || "Screenshot";
}

function applitoolsSummary({ status, isNew, isDifferent, mismatches, missing, changed }) {
  if (isNew && !changed) {
    return "Applitools created a new baseline; approve it in Eyes before future runs compare against it.";
  }
  if (!changed) {
    return `Applitools visual check passed (${status}).`;
  }
  return `Applitools detected a visual difference (${status}; mismatches=${mismatches}; missing=${missing}; different=${isDifferent}).`;
}

function normalizeStepsInfo(stepsInfo) {
  return (Array.isArray(stepsInfo) ? stepsInfo : []).map((step) => ({
    name: resultValue(step, "getName", "name") || "",
    isDifferent: Boolean(resultValue(step, "getIsDifferent", "isDifferent")),
    appUrls: resultValue(step, "getAppUrls", "appUrls") || null
  }));
}

function resultValue(object, methodName, propertyName) {
  if (!object) {
    return null;
  }
  if (typeof object[methodName] === "function") {
    return object[methodName]();
  }
  return object[propertyName] ?? null;
}

function callIfExists(object, methodName, value) {
  if (typeof object?.[methodName] === "function" && value !== null && value !== undefined && value !== "") {
    object[methodName](value);
  }
}

function cleanNamePart(value) {
  return cleanText(value).replace(/\s+/g, " ").slice(0, 120) || "unknown";
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function booleanOption(value, fallback = false) {
  const text = cleanText(value).toLowerCase();
  if (!text) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(text);
}
