import fs from "node:fs/promises";
import path from "node:path";
import { capturePage, findBrowser } from "./browser.js";
import { assessRelatedShotConfidence, assessSnapshotConfidence } from "./capture-confidence.js";
import { createCaptureDiagnosticRun, finalizeCaptureDiagnostic, recordCaptureDiagnostic } from "./capture-diagnostics.js";
import { rebuildChanges } from "./changes.js";
import { devicePresets, findDevicePreset, toPublicDevicePreset } from "./device-presets.js";
import { archiveDir } from "./paths.js";
import { shokzHomeRelatedSectionDefinitions, shokzRelatedSectionOrder } from "./shokz-capture-specs.js";
import {
  appendSnapshot,
  createSnapshotFilePath,
  loadConfig,
  normalizeCaptureTarget,
  normalizeConfig,
  publicSnapshotUrl
} from "./store.js";

export async function captureConfiguredUrls(config = null) {
  const activeConfig = config || await loadConfig();
  const results = [];
  for (const target of activeConfig.urls) {
    results.push(await captureOne(target, activeConfig));
  }
  return results;
}

export async function captureAllDevices(config = null) {
  const activeConfig = config || await loadConfig();
  const results = [];
  for (const preset of devicePresets) {
    const presetConfig = normalizeConfig({
      ...activeConfig,
      devicePresetId: preset.id
    });
    for (const target of presetConfig.urls) {
      results.push(await captureOne(target, presetConfig));
    }
  }
  return results;
}

export async function captureOne(inputTarget, config = null) {
  const activeConfig = config || await loadConfig();
  const target = normalizeCaptureTarget(inputTarget);
  const normalizedUrl = target.url;
  const capturedAt = new Date();
  const fileInfo = await createSnapshotFilePath(normalizedUrl, capturedAt);
  const devicePreset = findDevicePreset(activeConfig.devicePresetId);
  const publicDevice = devicePreset ? toPublicDevicePreset(devicePreset) : null;
  const captureConfig = captureConfigForTarget(activeConfig, target);
  const diagnosticRun = createCaptureDiagnosticRun({
    targetId: target.id,
    targetLabel: target.label || normalizedUrl,
    requestedUrl: normalizedUrl,
    captureMode: target.captureMode || null,
    devicePresetId: publicDevice?.id || activeConfig.devicePresetId || null
  });

  try {
    const capture = await capturePage(normalizedUrl, fileInfo.absolutePath, captureConfig);
    recordCaptureDiagnostic(diagnosticRun, {
      type: "main-capture",
      ok: true,
      finalUrl: capture.finalUrl || normalizedUrl,
      width: capture.width || null,
      height: capture.height || null,
      visualAudit: capture.visualAudit || null,
      urlCheck: capture.urlCheck || null
    });
    const relatedCapture = await captureRelatedShotsForTarget(
      target,
      normalizedUrl,
      fileInfo.absolutePath,
      captureConfig,
      diagnosticRun
    );
    const relatedShots = relatedCapture.shots;
    const stamp = capturedAt.toISOString().replace(/[:.]/g, "-");
    const targetLabel = target.label || normalizedUrl;
    const captureItems = Array.isArray(capture.captures) && capture.captures.length
      ? capture.captures
      : [capture];
    const snapshots = [];

    for (const item of captureItems) {
      const absolutePath = item.outputPath || fileInfo.absolutePath;
      const relativePath = absolutePath === fileInfo.absolutePath
        ? fileInfo.relativePath
        : archiveRelativePath(absolutePath);
      const stat = await fs.stat(absolutePath);
      const itemTargetId = item.bannerIndex ? `${target.id}-banner-${item.bannerIndex}` : target.id;
      const itemTargetLabel = item.bannerIndex ? `\u9996\u9875 Banner ${item.bannerIndex}` : targetLabel;
      const displayUrl = item.bannerIndex ? bannerDisplayLabel(targetLabel, item.bannerIndex) : targetLabel;
      const visualAudit = item.visualAudit || capture.visualAudit || null;
      const captureConfidence = assessSnapshotConfidence({
        visualAudit,
        urlCheck: capture.urlCheck || null
      });
      const snapshot = await appendSnapshot({
        id: `${stamp}-${fileInfo.siteSlug}-${itemTargetId}-${publicDevice?.id || "device"}`,
        url: normalizedUrl,
        targetId: itemTargetId,
        targetLabel: itemTargetLabel,
        displayUrl,
        captureMode: target.captureMode || null,
        requestedUrl: capture.requestedUrl || normalizedUrl,
        finalUrl: capture.finalUrl || normalizedUrl,
        urlCheck: capture.urlCheck || null,
        title: capture.title,
        capturedAt: capturedAt.toISOString(),
        file: relativePath,
        imageUrl: publicSnapshotUrl(relativePath),
        bytes: stat.size,
        width: item.width || capture.width,
        height: item.height || capture.height,
        devicePresetId: publicDevice?.id || activeConfig.devicePresetId || null,
        deviceName: publicDevice?.name || null,
        deviceLabel: publicDevice?.label || null,
        fullPageHeight: capture.fullPageHeight,
        truncated: capture.truncated,
        scrollInfo: capture.scrollInfo,
        browserPath: capture.browserPath,
        bannerIndex: item.bannerIndex || null,
        bannerCount: item.bannerCount || null,
        bannerSignature: item.bannerSignature || null,
        visualSignature: item.visualSignature || null,
        visualAudit,
        captureConfidence,
        bannerClip: item.bannerClip || null,
        bannerState: item.bannerState || null,
        bannerValidation: item.bannerIndex ? capture.bannerInfo || null : null,
        relatedValidation: !item.bannerIndex ? relatedCapture.validation : null,
        relatedShots: !item.bannerIndex && relatedShots.length ? relatedShots : null
      });
      snapshots.push(snapshot);
    }

    const changeRefresh = await refreshChangeRecords();
    recordCaptureDiagnostic(diagnosticRun, {
      type: "snapshot-write",
      ok: true,
      snapshotCount: snapshots.length,
      relatedShotCount: relatedShots.length,
      lowConfidenceSnapshots: snapshots
        .filter((snapshot) => snapshot.captureConfidence?.baselineEligible === false)
        .map((snapshot) => ({
          targetId: snapshot.targetId,
          reasons: snapshot.captureConfidence.reasons
        })),
      lowConfidenceRelatedShots: relatedShots
        .filter((shot) => shot.captureConfidence?.baselineEligible === false)
        .map((shot) => ({
          sectionKey: shot.sectionKey,
          stateLabel: shot.stateLabel || shot.label || null,
          reasons: shot.captureConfidence.reasons
        })),
      changeRefresh
    });
    await finalizeCaptureDiagnostic(diagnosticRun, {
      ok: true,
      targetId: target.id,
      requestedUrl: normalizedUrl,
      snapshotCount: snapshots.length,
      relatedShotCount: relatedShots.length,
      lowConfidenceSnapshotCount: snapshots.filter((snapshot) => snapshot.captureConfidence?.baselineEligible === false).length,
      lowConfidenceRelatedShotCount: relatedShots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length,
      warningCount: Array.isArray(relatedCapture.validation?.warnings) ? relatedCapture.validation.warnings.length : 0,
      changeRefresh
    });
    return { ok: true, snapshot: snapshots[0], snapshots, changeRefresh };
  } catch (error) {
    await removeCaptureOutputs(fileInfo.absolutePath);
    recordCaptureDiagnostic(diagnosticRun, {
      type: "capture-error",
      ok: false,
      error: error.message,
      requestedUrl: error.requestedUrl || normalizedUrl,
      finalUrl: error.finalUrl || null,
      urlCheck: error.urlCheck || null
    });
    await finalizeCaptureDiagnostic(diagnosticRun, {
      ok: false,
      targetId: target.id,
      requestedUrl: normalizedUrl,
      error: error.message
    });
    return {
      ok: false,
      url: normalizedUrl,
      targetId: target.id,
      targetLabel: target.label || normalizedUrl,
      displayUrl: target.label || normalizedUrl,
      captureMode: target.captureMode || null,
      requestedUrl: error.requestedUrl || normalizedUrl,
      finalUrl: error.finalUrl || null,
      urlCheck: error.urlCheck || null,
      capturedAt: capturedAt.toISOString(),
      error: error.message
    };
  }
}

async function refreshChangeRecords() {
  try {
    const changes = await rebuildChanges();
    return { ok: true, count: changes.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function captureConfigForTarget(config, target) {
  const targetConfig = { ...config };
  if (Object.hasOwn(target, "fullPage")) {
    targetConfig.fullPage = target.fullPage;
  }
  if (target.captureMode) {
    targetConfig.captureMode = target.captureMode;
  }
  return targetConfig;
}

function relatedCaptureModeForTarget(target, captureConfig) {
  if ((target.id === "shokz-products-nav" || target.captureMode === "shokz-products-nav") && !captureConfig.viewport?.mobile) {
    return "shokz-products-nav-related";
  }

  return null;
}

async function captureRelatedShotsForTarget(target, normalizedUrl, baseOutputPath, captureConfig, diagnosticRun = null) {
  if (target.id === "shokz-home" && !target.captureMode) {
    return captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun);
  }

  const relatedMode = relatedCaptureModeForTarget(target, captureConfig);
  if (!relatedMode) {
    return { shots: [], validation: null };
  }

  let relatedCapture;
  try {
    relatedCapture = await capturePage(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: relatedMode,
      fullPage: false,
      lazyLoadScroll: false
    });
  } catch (error) {
    await removeSidecarOutputs(baseOutputPath);
    recordCaptureDiagnostic(diagnosticRun, {
      type: "related-capture",
      ok: false,
      sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "related",
      sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation" : "More screenshots",
      captureMode: relatedMode,
      error: error.message
    });
    return {
      shots: [],
      validation: {
        status: "warning",
        warnings: [{
          sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "home-related",
          sectionLabel: "更多截图",
          message: error.message
        }],
        sections: []
      }
    };
  }

  const validation = validationForRelatedCaptureResult(relatedCapture, {
    sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "related",
    sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation" : "More screenshots"
  });
  const relatedShots = [];

  for (const item of relatedCapture.captures || []) {
    const bannerIndex = Number(item.bannerIndex || 0);
    const relativePath = archiveRelativePath(item.outputPath);
    const stat = await fs.stat(item.outputPath);
    const shot = {
      label: relatedShotLabelForCaptureItem(item),
      file: relativePath,
      imageUrl: publicSnapshotUrl(relativePath),
      bytes: stat.size,
      width: item.width,
      height: item.height,
      kind: item.kind || "banner",
      sectionKey: item.sectionKey || "banner",
      sectionLabel: item.sectionLabel || "Banner",
      sectionTitle: item.sectionTitle || "Banner 轮播图",
      stateIndex: item.stateIndex || bannerIndex || null,
      stateCount: item.stateCount || item.bannerCount || null,
      stateLabel: item.stateLabel || item.label || (bannerIndex ? `轮播 ${bannerIndex}` : "轮播"),
      tabLabel: item.tabLabel || null,
      tabIndex: item.tabIndex || null,
      pageIndex: item.pageIndex || null,
      interactionState: item.interactionState || "default",
      navigationLevel: item.navigationLevel || null,
      topLevelLabel: item.topLevelLabel || null,
      topLevelIndex: item.topLevelIndex || null,
      hoverItemKey: item.hoverItemKey || null,
      hoverItemLabel: item.hoverItemLabel || null,
      hoverItemRect: item.hoverItemRect || null,
      basePageIndex: item.basePageIndex || null,
      hoverIndex: item.hoverIndex || null,
      trackLabel: item.trackLabel || item.tabLabel || null,
      trackIndex: item.trackIndex || item.tabIndex || null,
      productCount: item.productCount || null,
      visibleProductCount: item.visibleProductCount || null,
      visibleProducts: item.visibleProducts || null,
      itemCount: item.itemCount || null,
      visibleItemCount: item.visibleItemCount || null,
      visibleItems: item.visibleItems || null,
      itemRects: item.itemRects || null,
      windowSignature: item.windowSignature || null,
      logicalSignature: item.logicalSignature || item.bannerSignature || null,
      visualHash: item.visualHash || null,
      visualAudit: item.visualAudit || null,
      clip: item.clip || item.bannerClip || null,
      isDefaultState: Boolean(item.isDefaultState),
      coverageKey: item.coverageKey || null,
      bannerIndex: item.bannerIndex,
      bannerCount: item.bannerCount,
      bannerSignature: item.bannerSignature || null,
      visualSignature: item.visualSignature || null,
      bannerClip: item.bannerClip || null,
      bannerState: item.bannerState || null,
      sectionState: item.sectionState || null,
      urlCheck: relatedCapture.urlCheck || null,
      requestedUrl: relatedCapture.requestedUrl || normalizedUrl,
      finalUrl: relatedCapture.finalUrl || normalizedUrl
    };
    shot.captureConfidence = assessRelatedShotConfidence(shot, validation);
    relatedShots.push(shot);
  }

  recordCaptureDiagnostic(diagnosticRun, {
    type: "related-capture",
    ok: true,
    sectionKey: relatedMode === "shokz-products-nav-related" ? "navigation" : "related",
    sectionLabel: relatedMode === "shokz-products-nav-related" ? "Navigation" : "More screenshots",
    captureMode: relatedMode,
    shotCount: relatedShots.length,
    warningCount: Array.isArray(validation?.warnings) ? validation.warnings.length : 0,
    lowConfidenceShotCount: relatedShots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length
  });
  return {
    shots: relatedShots.sort(compareRelatedShots),
    validation
  };
}

async function captureShokzHomeRelatedShotsIsolated(normalizedUrl, baseOutputPath, captureConfig, diagnosticRun) {
  const descriptors = [
    {
      sectionKey: "banner",
      sectionLabel: "Banner",
      captureMode: "shokz-home-banners"
    },
    ...shokzHomeRelatedSectionDefinitions.map((definition) => ({
      sectionKey: definition.key,
      sectionLabel: definition.sectionLabel,
      captureMode: "shokz-home-related-section",
      sectionCaptureKey: definition.key
    }))
  ];
  const shots = [];
  const warnings = [];
  const sections = [];

  for (const descriptor of descriptors) {
    const result = await captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun);
    shots.push(...result.shots);
    warnings.push(...(result.validation?.warnings || []));
    sections.push(...(result.validation?.sections || []));
  }

  return {
    shots: shots.sort(compareRelatedShots),
    validation: {
      status: warnings.length ? "warning" : "ok",
      warnings,
      sections
    }
  };
}

async function captureIsolatedRelatedSection(normalizedUrl, baseOutputPath, captureConfig, descriptor, diagnosticRun) {
  let relatedCapture;
  try {
    relatedCapture = await capturePage(normalizedUrl, baseOutputPath, {
      ...captureConfig,
      captureMode: descriptor.captureMode,
      sectionKey: descriptor.sectionCaptureKey || null,
      fullPage: false,
      lazyLoadScroll: false
    });
  } catch (error) {
    recordCaptureDiagnostic(diagnosticRun, {
      type: "related-capture",
      ok: false,
      sectionKey: descriptor.sectionKey,
      sectionLabel: descriptor.sectionLabel,
      captureMode: descriptor.captureMode,
      error: error.message
    });
    return {
      shots: [],
      validation: {
        status: "warning",
        warnings: [{
          sectionKey: descriptor.sectionKey,
          sectionLabel: descriptor.sectionLabel,
          message: error.message
        }],
        sections: [{
          sectionKey: descriptor.sectionKey,
          sectionLabel: descriptor.sectionLabel,
          expectedCount: 0,
          capturedCount: 0,
          savedCount: 0,
          status: "warning"
        }]
      }
    };
  }

  const validation = validationForRelatedCaptureResult(relatedCapture, descriptor);
  const shots = [];
  for (const shot of await relatedShotsFromCaptureResult(relatedCapture, normalizedUrl, validation)) {
    shots.push(shot);
  }
  recordCaptureDiagnostic(diagnosticRun, {
    type: "related-capture",
    ok: true,
    sectionKey: descriptor.sectionKey,
    sectionLabel: descriptor.sectionLabel,
    captureMode: descriptor.captureMode,
    shotCount: shots.length,
    warningCount: Array.isArray(validation?.warnings) ? validation.warnings.length : 0,
    lowConfidenceShotCount: shots.filter((shot) => shot.captureConfidence?.baselineEligible === false).length
  });
  return { shots, validation };
}

async function relatedShotsFromCaptureResult(relatedCapture, normalizedUrl, validation) {
  const relatedShots = [];

  for (const item of relatedCapture.captures || []) {
    const bannerIndex = Number(item.bannerIndex || 0);
    const relativePath = archiveRelativePath(item.outputPath);
    const stat = await fs.stat(item.outputPath);
    const shot = {
      label: relatedShotLabelForCaptureItem(item),
      file: relativePath,
      imageUrl: publicSnapshotUrl(relativePath),
      bytes: stat.size,
      width: item.width,
      height: item.height,
      kind: item.kind || "banner",
      sectionKey: item.sectionKey || "banner",
      sectionLabel: item.sectionLabel || "Banner",
      sectionTitle: item.sectionTitle || "Banner",
      stateIndex: item.stateIndex || bannerIndex || null,
      stateCount: item.stateCount || item.bannerCount || null,
      stateLabel: item.stateLabel || item.label || (bannerIndex ? `轮播 ${bannerIndex}` : "轮播"),
      tabLabel: item.tabLabel || null,
      tabIndex: item.tabIndex || null,
      pageIndex: item.pageIndex || null,
      interactionState: item.interactionState || "default",
      navigationLevel: item.navigationLevel || null,
      topLevelLabel: item.topLevelLabel || null,
      topLevelIndex: item.topLevelIndex || null,
      hoverItemKey: item.hoverItemKey || null,
      hoverItemLabel: item.hoverItemLabel || null,
      hoverItemRect: item.hoverItemRect || null,
      basePageIndex: item.basePageIndex || null,
      hoverIndex: item.hoverIndex || null,
      trackLabel: item.trackLabel || item.tabLabel || null,
      trackIndex: item.trackIndex || item.tabIndex || null,
      productCount: item.productCount || null,
      visibleProductCount: item.visibleProductCount || null,
      visibleProducts: item.visibleProducts || null,
      itemCount: item.itemCount || null,
      visibleItemCount: item.visibleItemCount || null,
      visibleItems: item.visibleItems || null,
      itemRects: item.itemRects || null,
      windowSignature: item.windowSignature || null,
      logicalSignature: item.logicalSignature || item.bannerSignature || null,
      visualHash: item.visualHash || null,
      visualAudit: item.visualAudit || null,
      clip: item.clip || item.bannerClip || null,
      isDefaultState: Boolean(item.isDefaultState),
      coverageKey: item.coverageKey || null,
      bannerIndex: item.bannerIndex,
      bannerCount: item.bannerCount,
      bannerSignature: item.bannerSignature || null,
      visualSignature: item.visualSignature || null,
      bannerClip: item.bannerClip || null,
      bannerState: item.bannerState || null,
      sectionState: item.sectionState || null,
      urlCheck: relatedCapture.urlCheck || null,
      requestedUrl: relatedCapture.requestedUrl || normalizedUrl,
      finalUrl: relatedCapture.finalUrl || normalizedUrl
    };
    shot.captureConfidence = assessRelatedShotConfidence(shot, validation);
    relatedShots.push(shot);
  }

  return relatedShots.sort(compareRelatedShots);
}

function validationForRelatedCaptureResult(relatedCapture, descriptor) {
  if (relatedCapture.relatedValidation) {
    return relatedCapture.relatedValidation;
  }
  const captures = Array.isArray(relatedCapture.captures) ? relatedCapture.captures : [];
  const savedCount = captures.length;
  const expectedCount = Number(relatedCapture.bannerInfo?.expectedCount || savedCount || 0);
  return {
    status: "ok",
    warnings: [],
    sections: [{
      sectionKey: descriptor.sectionKey,
      sectionLabel: descriptor.sectionLabel,
      expectedCount,
      capturedCount: savedCount,
      savedCount,
      status: "ok"
    }]
  };
}

function archiveRelativePath(absolutePath) {
  return path.relative(archiveDir, absolutePath).replaceAll(path.sep, "/");
}

export function relatedShotLabelForCaptureItem(item) {
  const stateLabel = String(item?.stateLabel || "").trim();
  if (stateLabel && !/undefined|null/i.test(stateLabel)) {
    return stateLabel;
  }

  const label = String(item?.label || "").trim();
  if (label && !/undefined|null/i.test(label)) {
    return label;
  }

  const bannerIndex = Number(item?.bannerIndex || 0);
  return bannerIndex ? `轮播 ${bannerIndex}` : "轮播";
}

function bannerDisplayLabel(label, bannerIndex) {
  if (/Banner\s*[)\uff09]\s*$/.test(label)) {
    return label.replace(/Banner\s*([)\uff09])\s*$/, `Banner ${bannerIndex}$1`);
  }
  if (/[)\uff09]\s*$/.test(label)) {
    return label.replace(/([)\uff09])\s*$/, ` Banner ${bannerIndex}$1`);
  }
  return `${label} Banner ${bannerIndex}`;
}

function compareRelatedShots(a, b) {
  const sectionA = shokzRelatedSectionOrder.indexOf(a.sectionKey);
  const sectionB = shokzRelatedSectionOrder.indexOf(b.sectionKey);
  const orderA = sectionA === -1 ? 1000 : sectionA;
  const orderB = sectionB === -1 ? 1000 : sectionB;
  return orderA - orderB ||
    Number(a.tabIndex || 0) - Number(b.tabIndex || 0) ||
    interactionSort(a) - interactionSort(b) ||
    Number(a.pageIndex || 0) - Number(b.pageIndex || 0) ||
    Number(a.hoverIndex || 0) - Number(b.hoverIndex || 0) ||
    Number(a.stateIndex || a.bannerIndex || 0) - Number(b.stateIndex || b.bannerIndex || 0) ||
    String(a.label || "").localeCompare(String(b.label || ""), "zh-CN");
}

function interactionSort(item) {
  return item?.interactionState === "hover" ? 1 : 0;
}

async function removeCaptureOutputs(basePath) {
  await fs.rm(basePath, { force: true });
  await removeSidecarOutputs(basePath);
}

async function removeSidecarOutputs(basePath) {
  const dir = path.dirname(basePath);
  const stem = path.basename(basePath, ".png");
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const bannerPath = basePath.replace(/\.png$/i, `-banner-${index + 1}.png`);
    return fs.rm(bannerPath, { force: true });
  }));
  await Promise.all(entries
    .filter((name) => name.startsWith(`${stem}-`) && name.endsWith(".png"))
    .map((name) => fs.rm(path.join(dir, name), { force: true })));
}

export async function browserStatus() {
  try {
    return { ok: true, path: await findBrowser() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
