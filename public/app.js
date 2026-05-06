const elements = {
  refresh: document.querySelector("#refresh"),
  tabs: [...document.querySelectorAll("[data-tab]")],
  tabPanels: [...document.querySelectorAll("[data-tab-panel]")],
  shotCount: document.querySelector("#shotCount"),
  scheduleState: document.querySelector("#scheduleState"),
  browserState: document.querySelector("#browserState"),
  captureState: document.querySelector("#captureState"),
  changeCount: document.querySelector("#changeCount"),
  latestShotTime: document.querySelector("#latestShotTime"),
  deviceFilter: document.querySelector("#deviceFilter"),
  deviceFilterButton: document.querySelector("#deviceFilterButton"),
  deviceFilterLabel: document.querySelector("#deviceFilterLabel"),
  deviceFilterMenu: document.querySelector("#deviceFilterMenu"),
  dateStartFilter: document.querySelector("#dateStartFilter"),
  dateEndFilter: document.querySelector("#dateEndFilter"),
  dateClearFilter: document.querySelector("#dateClearFilter"),
  urlFilter: document.querySelector("#urlFilter"),
  gallery: document.querySelector("#gallery"),
  empty: document.querySelector("#empty"),
  changesList: document.querySelector("#changesList"),
  changesEmpty: document.querySelector("#changesEmpty")
};

const homeBannerWindowMs = 5 * 60 * 1000;
const relatedSectionOrder = ["banner", "product-showcase", "scene-explore", "athletes", "media", "voices"];
const relatedSectionTitles = {
  banner: "Banner 轮播图",
  "product-showcase": "产品橱窗轮播图",
  "scene-explore": "场景探索轮播图",
  athletes: "运动员区轮播图",
  media: "媒体区轮播图",
  voices: "用户心声轮播图"
};

let state = null;
let activeTab = "archive";
const selectedDeviceFilters = {
  devices: new Set()
};

await refreshState();
setInterval(refreshState, 10000);

elements.refresh.addEventListener("click", refreshState);
for (const tab of elements.tabs) {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  tab.addEventListener("keydown", handleTabKeydown);
}
elements.urlFilter.addEventListener("change", renderGallery);
elements.dateStartFilter.addEventListener("change", renderGallery);
elements.dateEndFilter.addEventListener("change", renderGallery);
elements.dateClearFilter.addEventListener("click", clearDateFilter);
elements.deviceFilterButton.addEventListener("click", toggleDeviceFilterMenu);
elements.deviceFilterMenu.addEventListener("change", handleDeviceFilterChange);
elements.deviceFilterMenu.addEventListener("click", handleDeviceFilterClick);
document.addEventListener("click", closeDeviceFilterOnOutsideClick);
document.addEventListener("keydown", closeDeviceFilterOnEscape);

function setActiveTab(tabName) {
  activeTab = tabName === "changes" ? "changes" : "archive";

  for (const tab of elements.tabs) {
    const isActive = tab.dataset.tab === activeTab;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  }

  for (const panel of elements.tabPanels) {
    const isActive = panel.dataset.tabPanel === activeTab;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  }

  if (activeTab !== "archive") {
    setDeviceFilterMenuOpen(false);
  }
}

function handleTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const currentIndex = elements.tabs.indexOf(event.currentTarget);
  const lastIndex = elements.tabs.length - 1;
  let nextIndex = currentIndex;

  if (event.key === "ArrowLeft") {
    nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
  } else if (event.key === "ArrowRight") {
    nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = lastIndex;
  }

  const nextTab = elements.tabs[nextIndex];
  setActiveTab(nextTab.dataset.tab);
  nextTab.focus();
}

async function refreshState() {
  const response = await fetch("/api/state");
  state = await response.json();
  render();
}

function render() {
  elements.shotCount.textContent = state.snapshots.length;
  elements.changeCount.textContent = state.changesSummary?.count || 0;
  elements.captureState.textContent = state.capture.running ? "截图中" : "空闲";
  elements.browserState.textContent = state.browser.ok ? browserName(state.browser.path) : "未找到";
  elements.scheduleState.textContent = "整点（所有设备）";
  const latestCapturedAt = latestSnapshotCapturedAt();
  elements.latestShotTime.textContent = latestCapturedAt
    ? `最近一次截图时间：${formatDate(latestCapturedAt)}`
    : "最近一次截图时间：暂无";
  renderFilterOptions();
  renderDeviceFilterOptions();
  renderChangesSummary();
  renderGallery();
}

function latestSnapshotCapturedAt() {
  const latest = Math.max(...state.snapshots.map((snapshot) => timestamp(snapshot.capturedAt)));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function renderFilterOptions() {
  const current = elements.urlFilter.value;
  const urls = urlFilterOptions();
  elements.urlFilter.innerHTML = "<option value=\"\">全部 URL</option>";
  for (const url of urls) {
    const option = document.createElement("option");
    option.value = url;
    option.textContent = url;
    elements.urlFilter.append(option);
  }
  elements.urlFilter.value = urls.includes(current) ? current : "";
}

function renderDeviceFilterOptions() {
  const devices = uniqueDevicesFromSnapshots();
  const availableDeviceIds = new Set(devices.map((device) => device.id));
  selectedDeviceFilters.devices = new Set(
    [...selectedDeviceFilters.devices].filter((id) => availableDeviceIds.has(id))
  );

  const groups = deviceFilterGroups(devices);
  elements.deviceFilterMenu.innerHTML = "";

  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "device-filter-group";
    section.innerHTML = `
      <label class="device-filter-check device-filter-category">
        <input type="checkbox" data-filter-type="category" value="${group.id}">
        <span>${escapeHtml(group.name)}</span>
      </label>
      <div class="device-filter-options"></div>
    `;

    const categoryInput = section.querySelector("input");
    categoryInput.checked = group.devices.every((device) => selectedDeviceFilters.devices.has(device.id));

    const options = section.querySelector(".device-filter-options");
    for (const device of group.devices) {
      const label = document.createElement("label");
      label.className = "device-filter-check";
      label.innerHTML = `
        <input type="checkbox" data-filter-type="device" value="${escapeHtml(device.id)}">
        <span>${escapeHtml(device.name)}</span>
      `;
      label.querySelector("input").checked = selectedDeviceFilters.devices.has(device.id);
      options.append(label);
    }

    elements.deviceFilterMenu.append(section);
  }

  const actions = document.createElement("div");
  actions.className = "device-filter-actions";
  actions.innerHTML = "<button type=\"button\" data-filter-action=\"clear\">清除</button>";
  elements.deviceFilterMenu.append(actions);
  renderDeviceFilterLabel(devices);
}

function toggleDeviceFilterMenu() {
  const isOpen = elements.deviceFilter.dataset.open === "true";
  setDeviceFilterMenuOpen(!isOpen);
}

function setDeviceFilterMenuOpen(isOpen) {
  elements.deviceFilter.dataset.open = isOpen ? "true" : "false";
  elements.deviceFilterButton.setAttribute("aria-expanded", String(isOpen));
}

function closeDeviceFilterOnOutsideClick(event) {
  if (!elements.deviceFilter.contains(event.target)) {
    setDeviceFilterMenuOpen(false);
  }
}

function closeDeviceFilterOnEscape(event) {
  if (event.key === "Escape") {
    setDeviceFilterMenuOpen(false);
  }
}

function handleDeviceFilterClick(event) {
  const action = event.target.closest("[data-filter-action]")?.dataset.filterAction;
  if (action !== "clear") {
    return;
  }
  selectedDeviceFilters.devices.clear();
  renderDeviceFilterOptions();
  renderGallery();
}

function handleDeviceFilterChange(event) {
  const input = event.target.closest("input[type='checkbox']");
  if (!input) {
    return;
  }

  if (input.dataset.filterType === "category") {
    const group = deviceFilterGroups(uniqueDevicesFromSnapshots()).find((item) => item.id === input.value);
    const deviceIds = group?.devices.map((device) => device.id) || [];
    for (const deviceId of deviceIds) {
      if (input.checked) {
        selectedDeviceFilters.devices.add(deviceId);
      } else {
        selectedDeviceFilters.devices.delete(deviceId);
      }
    }
  } else if (input.checked) {
    selectedDeviceFilters.devices.add(input.value);
  } else {
    selectedDeviceFilters.devices.delete(input.value);
  }

  renderDeviceFilterOptions();
  renderGallery();
}

function renderDeviceFilterLabel(devices) {
  const selectedDevices = devices.filter((device) => selectedDeviceFilters.devices.has(device.id));
  const label = selectedDevices.length === 0
    ? "全部截图设备"
    : `已选 ${selectedDevices.length} 项`;
  elements.deviceFilterLabel.textContent = label;
  elements.deviceFilterButton.title = selectedDevices.map((device) => device.name).join("、");
}

function deviceFilterGroups(devices) {
  const groups = [
    { id: "mobile", name: "手机端", devices: [] },
    { id: "pc", name: "PC端", devices: [] }
  ];
  for (const device of devices) {
    const group = groups.find((item) => item.id === device.group) || groups[1];
    group.devices.push(device);
  }
  return groups.filter((group) => group.devices.length > 0);
}

function matchesDeviceFilters(snapshot) {
  if (selectedDeviceFilters.devices.size === 0) {
    return true;
  }

  const device = deviceInfoForSnapshot(snapshot);
  return selectedDeviceFilters.devices.has(device.id);
}

function matchesTimeFilter(snapshot) {
  const range = selectedDateRange();
  if (!range) {
    return true;
  }

  const capturedAt = timestamp(snapshot.capturedAt);
  if (!capturedAt) {
    return false;
  }

  return capturedAt >= range.start && capturedAt <= range.end;
}

function selectedDateRange() {
  const start = startOfDay(elements.dateStartFilter.value);
  const end = endOfDay(elements.dateEndFilter.value);

  if (!Number.isFinite(start) && !Number.isFinite(end)) {
    return null;
  }

  const min = Number.isFinite(start) ? start : Number.NEGATIVE_INFINITY;
  const max = Number.isFinite(end) ? end : Number.POSITIVE_INFINITY;
  return min <= max
    ? { start: min, end: max }
    : { start: max, end: min };
}

function clearDateFilter() {
  elements.dateStartFilter.value = "";
  elements.dateEndFilter.value = "";
  renderGallery();
}

function startOfDay(value) {
  if (!value) {
    return NaN;
  }
  const date = new Date(`${value}T00:00:00`);
  return date.getTime();
}

function endOfDay(value) {
  if (!value) {
    return NaN;
  }
  const date = new Date(`${value}T23:59:59.999`);
  return date.getTime();
}

function renderChangesSummary() {
  const changes = state.changesSummary?.recent || [];
  elements.changesList.innerHTML = "";
  elements.changesEmpty.classList.toggle("visible", changes.length === 0);

  for (const change of changes) {
    const item = document.createElement("article");
    item.className = "change-card";
    item.innerHTML = `
      <div class="change-card-main">
        <div>
          <p class="change-title">${escapeHtml(changeTitle(change))}</p>
          <p class="change-meta">
            <span class="pill">${escapeHtml(changeTypeLabel(change))}</span>
            <span class="pill device">${escapeHtml(change.location?.deviceName || change.location?.devicePresetId || "未知设备")}</span>
            <span>${formatDate(change.from?.capturedAt)} → ${formatDate(change.to?.capturedAt)}</span>
          </p>
        </div>
      </div>
      ${renderChangeComparisonImages(change)}
      ${renderTextChange(change.textChange)}
      ${renderVisualChange(change.visualChange)}
    `;
    elements.changesList.append(item);
  }
}

function renderChangeComparisonImages(change) {
  return `
    <div class="change-compare-grid">
      ${renderChangeImage("变化前", change.from?.imageUrl, change.from?.capturedAt)}
      ${renderChangeImage("变化后", change.to?.imageUrl, change.to?.capturedAt)}
      ${renderChangeImage("标注图", change.visualChange?.diffImageUrl, change.to?.capturedAt, "change-diff-image")}
    </div>
  `;
}

function renderChangeImage(label, imageUrl, capturedAt, extraClass = "") {
  if (!imageUrl) {
    return `
      <div class="change-image ${extraClass}">
        <span>${escapeHtml(label)}</span>
        <p>暂无图片</p>
      </div>
    `;
  }
  return `
    <a class="change-image ${extraClass}" href="${imageUrl}" target="_blank" rel="noreferrer">
      <img src="${imageUrl}" alt="${escapeHtml(label)} ${capturedAt ? formatDate(capturedAt) : ""}" loading="lazy">
      <span>${escapeHtml(label)}</span>
    </a>
  `;
}

function renderTextChange(textChange) {
  if (!textChange) {
    return "";
  }
  return `
    <div class="change-text">
      <p><span>从</span>${escapeHtml(textChange.beforeFragment || textChange.before || "（空）")}</p>
      <p><span>到</span>${escapeHtml(textChange.afterFragment || textChange.after || "（空）")}</p>
    </div>
  `;
}

function renderVisualChange(visualChange) {
  if (!visualChange) {
    return "";
  }
  if (visualChange.skipped) {
    return `<p class="change-note">视觉对比跳过：${escapeHtml(visualChange.reason || "无法读取图片")}</p>`;
  }
  const ratio = `${(Number(visualChange.ratio || 0) * 100).toFixed(2)}%`;
  const summary = visualChangeSummary(visualChange);
  const judgment = summary ? `，判断依据：${escapeHtml(summary)}` : "";
  return `
    <p class="change-note">
      视觉变化：${visualChange.regionCount || 0} 个区域，变化像素占比 ${ratio}${judgment}
    </p>
  `;
}

function visualChangeSummary(visualChange) {
  const labels = (visualChange.signals || []).map(visualSignalLabel).filter(Boolean);
  if (labels.length) {
    return labels.join("、");
  }
  return visualChange.summary || "";
}

function visualSignalLabel(signal) {
  return {
    copy: "文案变化",
    image: "图片素材变化",
    layout: "内容位置明显变化",
    dimension: "图片尺寸变化",
    "large-visual": "大面积视觉变化"
  }[signal.type] || signal.label || "";
}

function changeTitle(change) {
  return [
    change.location?.displayUrl,
    change.location?.sectionLabel,
    change.location?.tabLabel,
    change.location?.label
  ].filter(Boolean).join(" / ") || "页面变化";
}

function changeTypeLabel(change) {
  if (change.textChange && change.visualChange) {
    return "文案 + 视觉";
  }
  if (change.textChange) {
    return "文案";
  }
  return "视觉";
}

function renderGallery() {
  const selectedUrl = elements.urlFilter.value;
  const snapshots = state.snapshots.filter((snapshot) => {
    const matchesUrl = selectedUrl ? canonicalDisplayUrlForSnapshot(snapshot) === selectedUrl : true;
    const matchesTime = matchesTimeFilter(snapshot);
    const matchesDevice = matchesDeviceFilters(snapshot);
    return matchesUrl && matchesTime && matchesDevice;
  });
  const cards = buildGalleryCards(snapshots);

  elements.gallery.innerHTML = "";
  elements.empty.classList.toggle("visible", cards.length === 0);

  for (const card of cards) {
    elements.gallery.append(renderShotCard(card));
  }
}

function buildGalleryCards(snapshots) {
  const cards = [];
  const homeGroups = [];
  const homeBanners = [];

  for (const snapshot of snapshots) {
    if (isHomeBannerSnapshot(snapshot)) {
      homeBanners.push(snapshot);
      continue;
    }

    if (isHomeSnapshot(snapshot)) {
      const group = createHomeGroup(snapshot);
      cards.push(group);
      homeGroups.push(group);
      continue;
    }

    cards.push({
      snapshot,
      relatedShots: [],
      sortTime: timestamp(snapshot.capturedAt),
      homeGroup: false
    });
  }

  for (const banner of homeBanners) {
    const group = findMatchingHomeGroup(banner, homeGroups) || createFallbackHomeGroup(banner, cards, homeGroups);
    addRelatedShot(group, relatedShotFromSnapshot(banner));
  }

  for (const group of homeGroups) {
    group.relatedShots = sortedRelatedShots(group.relatedShots);
  }

  return cards.sort((a, b) => b.sortTime - a.sortTime);
}

function createHomeGroup(snapshot) {
  const group = {
    snapshot,
    relatedShots: [],
    sortTime: timestamp(snapshot.capturedAt),
    homeGroup: true,
    groupKey: homeGroupKey(snapshot),
    mainBannerIndex: null,
    relatedValidation: snapshot.relatedValidation || null
  };
  for (const relatedShot of relatedShotsFromSnapshot(snapshot)) {
    addRelatedShot(group, relatedShot);
  }
  return group;
}

function createFallbackHomeGroup(banner, cards, homeGroups) {
  const group = {
    snapshot: banner,
    relatedShots: [],
    sortTime: timestamp(banner.capturedAt),
    homeGroup: true,
    fallbackHome: true,
    groupKey: homeGroupKey(banner),
    mainBannerIndex: Number(banner.bannerIndex || 0) || null,
    relatedValidation: banner.relatedValidation || null
  };
  cards.push(group);
  homeGroups.push(group);
  return group;
}

function findMatchingHomeGroup(banner, homeGroups) {
  const key = homeGroupKey(banner);
  const bannerTime = timestamp(banner.capturedAt);
  return homeGroups
    .filter((group) => group.groupKey === key)
    .map((group) => ({ group, distance: Math.abs(group.sortTime - bannerTime) }))
    .filter((item) => item.distance <= homeBannerWindowMs)
    .sort((a, b) => a.distance - b.distance)[0]?.group || null;
}

function addRelatedShot(group, relatedShot) {
  if (!relatedShot) {
    return;
  }
  if (
    (relatedShot.kind === "banner" || relatedShot.sectionKey === "banner") &&
    (relatedShot.isDefaultState || Number(relatedShot.bannerIndex || 0) <= 1)
  ) {
    return;
  }
  if (group.mainBannerIndex && Number(relatedShot.bannerIndex) === group.mainBannerIndex) {
    return;
  }
  if (relatedShot.file && relatedShot.file === group.snapshot.file) {
    return;
  }

  const key = [
    relatedShot.sectionKey || "banner",
    relatedShot.visualSignature || relatedShot.file || relatedShot.imageUrl || relatedShot.label
  ].join("|");
  if (group.relatedShots.some((item) => [
    item.sectionKey || "banner",
    item.visualSignature || item.file || item.imageUrl || item.label
  ].join("|") === key)) {
    return;
  }
  group.relatedShots.push(relatedShot);
}

function sortedRelatedShots(relatedShots) {
  return [...relatedShots].sort((a, b) =>
    relatedSectionSort(a.sectionKey) - relatedSectionSort(b.sectionKey) ||
    String(a.tabLabel || "").localeCompare(String(b.tabLabel || ""), "zh-CN") ||
    Number(a.pageIndex || 0) - Number(b.pageIndex || 0) ||
    Number(a.stateIndex || 0) - Number(b.stateIndex || 0) ||
    Number(a.bannerIndex || 0) - Number(b.bannerIndex || 0) ||
    String(a.label || "").localeCompare(String(b.label || ""), "zh-CN")
  );
}

function relatedSectionSort(sectionKey) {
  const index = relatedSectionOrder.indexOf(sectionKey || "banner");
  return index === -1 ? 1000 : index;
}

function renderShotCard(card) {
  const snapshot = card.snapshot;
  const displayUrl = card.homeGroup ? homeDisplayUrl() : canonicalDisplayUrlForSnapshot(snapshot);
  const item = document.createElement("article");
  const hasRelatedWarning = relatedWarnings(card.relatedValidation).length > 0;
  item.className = [
    "shot",
    card.relatedShots.length ? "has-related-shots" : "",
    hasRelatedWarning ? "has-related-warning" : ""
  ].filter(Boolean).join(" ");
  item.innerHTML = `
    <a class="shot-main-image" href="${snapshot.imageUrl}" target="_blank" rel="noreferrer">
      <img src="${snapshot.imageUrl}" alt="${escapeHtml(displayUrl)} ${formatDate(snapshot.capturedAt)}" loading="lazy">
    </a>
    <div class="shot-info">
      <p class="shot-title" title="${escapeHtml(snapshot.title || displayUrl)}">${escapeHtml(displayUrl)}</p>
      <p class="shot-meta">
        <span class="pill">${formatDate(snapshot.capturedAt)}</span>
        <span class="pill device">${escapeHtml(deviceNameForSnapshot(snapshot))}</span>
        <span class="pill">${snapshot.width}×${snapshot.height}</span>
        ${snapshot.truncated ? "<span class=\"pill warn\">已截断</span>" : ""}
      </p>
    </div>
    ${renderRelatedShots(card.relatedShots, card.relatedValidation)}
  `;
  return item;
}

function renderRelatedShots(relatedShots, validation = null) {
  const warnings = relatedWarnings(validation);
  if (!relatedShots.length && !warnings.length) {
    return "<div class=\"shot-related shot-related-empty\" aria-hidden=\"true\"></div>";
  }
  const groups = groupRelatedShots(relatedShots);
  const warningTitle = warnings.map((warning) =>
    `${warning.sectionLabel || warning.sectionKey || "更多截图"}：${warning.message || "校验警告"}`
  ).join("\n");

  return `
    <div class="shot-related">
      <p class="related-kicker">
        更多截图
        ${warnings.length ? `<span class="related-warning" title="${escapeHtml(warningTitle)}">校验警告</span>` : ""}
      </p>
      ${groups.map((group) => `
        <section class="related-section">
          <p class="related-title">${escapeHtml(group.title)}</p>
          <div class="related-grid">
            ${group.shots.map((shot) => `
              <a class="related-thumb" href="${shot.imageUrl}" target="_blank" rel="noreferrer" title="${escapeHtml(relatedShotTitle(shot))}">
                <img src="${shot.imageUrl}" alt="${escapeHtml(shot.label)}" loading="lazy">
                <span>${escapeHtml(shot.label)}</span>
              </a>
            `).join("")}
          </div>
        </section>
      `).join("")}
    </div>
  `;
}

function groupRelatedShots(relatedShots) {
  const groups = new Map();
  for (const shot of sortedRelatedShots(relatedShots)) {
    const sectionKey = shot.sectionKey || "banner";
    if (!groups.has(sectionKey)) {
      groups.set(sectionKey, {
        sectionKey,
        title: shot.sectionTitle || relatedSectionTitles[sectionKey] || shot.sectionLabel || "更多截图",
        shots: []
      });
    }
    groups.get(sectionKey).shots.push(shot);
  }
  return [...groups.values()].sort((a, b) => relatedSectionSort(a.sectionKey) - relatedSectionSort(b.sectionKey));
}

function relatedWarnings(validation) {
  return Array.isArray(validation?.warnings) ? validation.warnings : [];
}

function relatedShotTitle(shot) {
  return [
    shot.sectionLabel,
    shot.tabLabel,
    shot.label,
    shot.visualAudit?.status === "warning" ? shot.visualAudit.message : ""
  ].filter(Boolean).join(" / ");
}

function relatedShotsFromSnapshot(snapshot) {
  if (!Array.isArray(snapshot.relatedShots)) {
    return [];
  }
  return snapshot.relatedShots
    .map((shot) => normalizeRelatedShot(shot))
    .filter(Boolean);
}

function relatedShotFromSnapshot(snapshot) {
  return normalizeRelatedShot({
    kind: "banner",
    sectionKey: "banner",
    sectionLabel: "Banner",
    sectionTitle: relatedSectionTitles.banner,
    label: `轮播 ${snapshot.bannerIndex || ""}`.trim(),
    file: snapshot.file,
    imageUrl: snapshot.imageUrl,
    bytes: snapshot.bytes,
    width: snapshot.width,
    height: snapshot.height,
    bannerIndex: snapshot.bannerIndex,
    bannerCount: snapshot.bannerCount,
    bannerSignature: snapshot.bannerSignature,
    visualSignature: snapshot.visualSignature,
    visualHash: snapshot.visualHash,
    visualAudit: snapshot.visualAudit,
    bannerClip: snapshot.bannerClip,
    bannerState: snapshot.bannerState,
    urlCheck: snapshot.urlCheck,
    requestedUrl: snapshot.requestedUrl,
    finalUrl: snapshot.finalUrl
  });
}

function normalizeRelatedShot(shot) {
  if (!shot || !shot.imageUrl) {
    return null;
  }
  const bannerIndex = Number(shot.bannerIndex || 0) || null;
  const sectionKey = shot.sectionKey || (bannerIndex ? "banner" : "related");
  return {
    kind: shot.kind || "banner",
    sectionKey,
    sectionLabel: shot.sectionLabel || (sectionKey === "banner" ? "Banner" : ""),
    sectionTitle: shot.sectionTitle || relatedSectionTitles[sectionKey] || "",
    label: shot.label || (bannerIndex ? `轮播 ${bannerIndex}` : "轮播"),
    file: shot.file || "",
    imageUrl: shot.imageUrl,
    bytes: shot.bytes || null,
    width: shot.width || null,
    height: shot.height || null,
    stateIndex: shot.stateIndex || bannerIndex || null,
    stateCount: shot.stateCount || shot.bannerCount || null,
    stateLabel: shot.stateLabel || shot.label || null,
    tabLabel: shot.tabLabel || null,
    tabIndex: shot.tabIndex || null,
    pageIndex: shot.pageIndex || null,
    logicalSignature: shot.logicalSignature || shot.bannerSignature || null,
    visualHash: shot.visualHash || null,
    visualAudit: shot.visualAudit || null,
    clip: shot.clip || shot.bannerClip || null,
    isDefaultState: Boolean(shot.isDefaultState),
    bannerIndex,
    bannerCount: shot.bannerCount || null,
    bannerSignature: shot.bannerSignature || null,
    visualSignature: shot.visualSignature || null,
    bannerClip: shot.bannerClip || null,
    bannerState: shot.bannerState || null,
    sectionState: shot.sectionState || null,
    urlCheck: shot.urlCheck || null,
    requestedUrl: shot.requestedUrl || null,
    finalUrl: shot.finalUrl || null
  };
}

function urlFilterOptions() {
  const configured = (state.config?.urls || []).map(displayUrlForTarget);
  return [...new Set(configured)];
}

function canonicalDisplayUrlForSnapshot(snapshot) {
  if (isProductsNavSnapshot(snapshot)) {
    return navDisplayUrl();
  }
  if (isHomeBannerSnapshot(snapshot) || isHomeLikeSnapshot(snapshot)) {
    return homeDisplayUrl();
  }
  return displayUrlForSnapshot(snapshot);
}

function isHomeSnapshot(snapshot) {
  return !isHomeBannerSnapshot(snapshot) && !isProductsNavSnapshot(snapshot) && isHomeLikeSnapshot(snapshot);
}

function isHomeLikeSnapshot(snapshot) {
  const displayUrl = displayUrlForSnapshot(snapshot);
  return snapshot.targetId === "shokz-home" ||
    snapshot.url === "https://shokz.com/" ||
    /首页/.test(displayUrl);
}

function isHomeBannerSnapshot(snapshot) {
  const displayUrl = displayUrlForSnapshot(snapshot);
  return snapshot.captureMode === "shokz-home-banners" ||
    String(snapshot.targetId || "").startsWith("shokz-home-banners") ||
    /首页\s*Banner/i.test(displayUrl);
}

function isProductsNavSnapshot(snapshot) {
  const displayUrl = displayUrlForSnapshot(snapshot);
  return snapshot.captureMode === "shokz-products-nav" ||
    snapshot.targetId === "shokz-products-nav" ||
    /导航栏/.test(displayUrl);
}

function homeDisplayUrl() {
  return displayUrlForTargetId("shokz-home") || "https://shokz.com/（首页）";
}

function navDisplayUrl() {
  return displayUrlForTargetId("shokz-products-nav") || "https://shokz.com/（导航栏）";
}

function displayUrlForTargetId(id) {
  const target = (state.config?.urls || []).find((item) => typeof item !== "string" && item.id === id);
  return target ? displayUrlForTarget(target) : "";
}

function displayUrlForSnapshot(snapshot) {
  return snapshot.displayUrl || snapshot.targetLabel || snapshot.url;
}

function displayUrlForTarget(target) {
  return typeof target === "string" ? target : target.label || target.url;
}

function homeGroupKey(snapshot) {
  return deviceIdForSnapshot(snapshot);
}

function deviceNameForSnapshot(snapshot) {
  return deviceInfoForSnapshot(snapshot).name;
}

function deviceIdForSnapshot(snapshot) {
  return deviceInfoForSnapshot(snapshot).id;
}

function deviceInfoForSnapshot(snapshot) {
  if (snapshot.devicePresetId) {
    const byId = (state?.devicePresets || []).find((preset) => preset.id === snapshot.devicePresetId);
    return {
      id: snapshot.devicePresetId,
      name: byId?.name || snapshot.deviceName || snapshot.devicePresetId,
      group: byId?.mobile ? "mobile" : "pc"
    };
  }

  const viewportHeight = snapshot.scrollInfo?.viewportHeight;
  const bySize = (state?.devicePresets || []).find((preset) =>
    Number(snapshot.width) === preset.width && Number(viewportHeight) === preset.height
  );
  if (bySize) {
    return { id: bySize.id, name: bySize.name, group: bySize.mobile ? "mobile" : "pc" };
  }

  const group = inferSnapshotDeviceGroup(snapshot);
  return {
    id: `custom-${group}`,
    name: group === "mobile" ? "自定义设备（手机端）" : "自定义设备（PC端）",
    group
  };
}

function uniqueDevicesFromSnapshots() {
  const devices = new Map();
  for (const snapshot of state.snapshots) {
    const device = deviceInfoForSnapshot(snapshot);
    devices.set(device.id, device);
  }
  return [...devices.values()].sort(compareDevices);
}

function compareDevices(a, b) {
  const orderA = devicePresetOrder(a.id);
  const orderB = devicePresetOrder(b.id);
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return a.name.localeCompare(b.name, "zh-CN");
}

function devicePresetOrder(id) {
  const index = (state?.devicePresets || []).findIndex((preset) => preset.id === id);
  return index === -1 ? 1000 : index;
}

function inferSnapshotDeviceGroup(snapshot) {
  const viewportHeight = Number(snapshot.scrollInfo?.viewportHeight || 0);
  const width = Number(snapshot.width || 0);
  return width > 0 && width <= 820 && (!viewportHeight || viewportHeight <= 1180) ? "mobile" : "pc";
}

function timestamp(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function browserName(browserPath) {
  if (/msedge/i.test(browserPath)) {
    return "Edge";
  }
  if (/chrome/i.test(browserPath)) {
    return "Chrome";
  }
  return "已找到";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}
