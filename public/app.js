import { configTargets, platformForChange, platformForSnapshot, platformLabel } from "./app-model.js";

const elements = {
  refresh: document.querySelector("#refresh"),
  platformTabs: [...document.querySelectorAll("[data-platform-tab]")],
  platformState: document.querySelector("#platformState"),
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
  changesDeviceFilter: document.querySelector("#changesDeviceFilter"),
  changesDeviceFilterButton: document.querySelector("#changesDeviceFilterButton"),
  changesDeviceFilterLabel: document.querySelector("#changesDeviceFilterLabel"),
  changesDeviceFilterMenu: document.querySelector("#changesDeviceFilterMenu"),
  changesDateStartFilter: document.querySelector("#changesDateStartFilter"),
  changesDateEndFilter: document.querySelector("#changesDateEndFilter"),
  changesDateClearFilter: document.querySelector("#changesDateClearFilter"),
  changesUrlFilter: document.querySelector("#changesUrlFilter"),
  archiveStatus: document.querySelector("#archiveStatus"),
  gallery: document.querySelector("#gallery"),
  empty: document.querySelector("#empty"),
  changesList: document.querySelector("#changesList"),
  changesPagination: document.querySelector("#changesPagination"),
  changesPaginationStatus: document.querySelector("#changesPaginationStatus"),
  changesPrevPage: document.querySelector("#changesPrevPage"),
  changesNextPage: document.querySelector("#changesNextPage"),
  changesEmpty: document.querySelector("#changesEmpty"),
  imagePreview: document.querySelector("#imagePreview"),
  imagePreviewViewport: document.querySelector("#imagePreviewViewport"),
  imagePreviewLongView: document.querySelector("#imagePreviewLongView"),
  imagePreviewMainFrame: document.querySelector("#imagePreviewMainFrame"),
  imagePreviewImage: document.querySelector("#imagePreviewImage"),
  imagePreviewDepthMarkers: document.querySelector("#imagePreviewDepthMarkers"),
  imagePreviewScreenRail: document.querySelector("#imagePreviewScreenRail"),
  imagePreviewCaption: document.querySelector("#imagePreviewCaption"),
  imagePreviewZoomOut: document.querySelector("#imagePreviewZoomOut"),
  imagePreviewZoomValue: document.querySelector("#imagePreviewZoomValue"),
  imagePreviewZoomIn: document.querySelector("#imagePreviewZoomIn"),
  imagePreviewZoomFit: document.querySelector("#imagePreviewZoomFit"),
  imagePreviewNavControls: document.querySelector("#imagePreviewNavControls"),
  imagePreviewPrev: document.querySelector("#imagePreviewPrev"),
  imagePreviewNext: document.querySelector("#imagePreviewNext"),
  imagePreviewClose: document.querySelector("#imagePreviewClose"),
  warningPreview: document.querySelector("#warningPreview"),
  warningPreviewTitle: document.querySelector("#warningPreviewTitle"),
  warningPreviewList: document.querySelector("#warningPreviewList"),
  warningPreviewClose: document.querySelector("#warningPreviewClose")
};

const homeBannerWindowMs = 5 * 60 * 1000;
const relatedSectionOrder = ["topbar", "banner", "navigation", "product-showcase", "scene-explore", "athletes", "media", "voices"];
const relatedSectionTitles = {
  topbar: "Topbar 轮播图",
  navigation: "导航栏分级截图",
  banner: "Banner 轮播图",
  "product-showcase": "产品橱窗轮播图",
  "scene-explore": "场景探索轮播图",
  athletes: "运动员区轮播图",
  media: "媒体区轮播图",
  voices: "用户心声轮播图"
};

let state = null;
let changes = [];
let activePlatform = "pc";
let imagePreviewReturnFocus = null;
let imagePreviewPreviousOverflow = "";
let imagePreviewZoomState = createImagePreviewZoomState();
let imagePreviewNavigationState = createImagePreviewNavigationState();
let warningPreviewReturnFocus = null;
let warningPreviewPreviousOverflow = "";
const changesPageSize = 10;
const imagePreviewDefaultMinScale = 0.25;
const imagePreviewMaxScale = 5;
const imagePreviewButtonScaleStep = 1.25;
const imagePreviewWheelScaleStep = 1.12;
const imagePreviewScreenRailGap = 24;
const changesPageByPlatform = {
  pc: 1,
  mobile: 1
};
const activeTabByPlatform = {
  pc: "archive",
  mobile: "archive"
};
const archiveFiltersByPlatform = createPlatformFilterMap();
const changesFiltersByPlatform = createPlatformFilterMap();
const pendingSnapshotDeletes = new Set();
let archiveStatusState = {
  tone: "info",
  message: ""
};

await refreshState();
setInterval(() => refreshState({ preserveScroll: true }), 10000);

elements.refresh.addEventListener("click", () => refreshState({ preserveScroll: true }));
for (const tab of elements.platformTabs) {
  tab.addEventListener("click", () => setActivePlatform(tab.dataset.platformTab));
  tab.addEventListener("keydown", handlePlatformTabKeydown);
}
for (const tab of elements.tabs) {
  tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  tab.addEventListener("keydown", handleTabKeydown);
}
elements.urlFilter.addEventListener("change", () => {
  activeArchiveFilters().url = elements.urlFilter.value;
  renderGallery({ preserveScroll: false });
});
elements.dateStartFilter.addEventListener("change", () => {
  activeArchiveFilters().dateStart = elements.dateStartFilter.value;
  renderGallery({ preserveScroll: false });
});
elements.dateEndFilter.addEventListener("change", () => {
  activeArchiveFilters().dateEnd = elements.dateEndFilter.value;
  renderGallery({ preserveScroll: false });
});
elements.dateClearFilter.addEventListener("click", clearDateFilter);
elements.deviceFilterButton.addEventListener("click", toggleDeviceFilterMenu);
elements.deviceFilterMenu.addEventListener("change", handleDeviceFilterChange);
elements.deviceFilterMenu.addEventListener("click", handleDeviceFilterClick);
elements.changesUrlFilter.addEventListener("change", () => {
  activeChangesFilters().url = elements.changesUrlFilter.value;
  renderChangesSummary({ resetPage: true });
});
elements.changesDateStartFilter.addEventListener("change", () => {
  activeChangesFilters().dateStart = elements.changesDateStartFilter.value;
  renderChangesSummary({ resetPage: true });
});
elements.changesDateEndFilter.addEventListener("change", () => {
  activeChangesFilters().dateEnd = elements.changesDateEndFilter.value;
  renderChangesSummary({ resetPage: true });
});
elements.changesDateClearFilter.addEventListener("click", clearChangesDateFilter);
elements.changesDeviceFilterButton.addEventListener("click", toggleChangesDeviceFilterMenu);
elements.changesDeviceFilterMenu.addEventListener("change", handleChangesDeviceFilterChange);
elements.changesDeviceFilterMenu.addEventListener("click", handleChangesDeviceFilterClick);
elements.changesPrevPage.addEventListener("click", () => changeChangesPage(-1));
elements.changesNextPage.addEventListener("click", () => changeChangesPage(1));
elements.gallery.addEventListener("click", handleGalleryClick);
elements.changesList.addEventListener("click", handleImagePreviewClick);
elements.imagePreview.addEventListener("click", handleImagePreviewBackdropClick);
elements.imagePreviewImage.addEventListener("load", handleImagePreviewImageLoad);
elements.imagePreviewViewport.addEventListener("wheel", handleImagePreviewWheel, { passive: false });
elements.imagePreviewViewport.addEventListener("pointerdown", startImagePreviewDrag);
elements.imagePreviewViewport.addEventListener("pointermove", moveImagePreviewDrag);
elements.imagePreviewViewport.addEventListener("pointerup", endImagePreviewDrag);
elements.imagePreviewViewport.addEventListener("pointercancel", endImagePreviewDrag);
elements.imagePreviewZoomOut.addEventListener("click", () => changeImagePreviewZoom(-1));
elements.imagePreviewZoomIn.addEventListener("click", () => changeImagePreviewZoom(1));
elements.imagePreviewZoomFit.addEventListener("click", fitImagePreviewToViewport);
elements.imagePreviewPrev.addEventListener("click", () => stepImagePreviewNavigation(-1));
elements.imagePreviewNext.addEventListener("click", () => stepImagePreviewNavigation(1));
elements.imagePreviewClose.addEventListener("click", closeImagePreview);
elements.warningPreview.addEventListener("click", handleWarningPreviewBackdropClick);
elements.warningPreviewClose.addEventListener("click", closeWarningPreview);
document.addEventListener("click", closeDeviceFilterOnOutsideClick);
document.addEventListener("keydown", closeDeviceFilterOnEscape);
document.addEventListener("keydown", handleImagePreviewNavigationKeydown);
document.addEventListener("keydown", closeImagePreviewOnEscape);
document.addEventListener("keydown", closeWarningPreviewOnEscape);
window.addEventListener("resize", handleImagePreviewResize);

function createPlatformFilterMap() {
  return {
    pc: createPlatformFilterState(),
    mobile: createPlatformFilterState()
  };
}

function createPlatformFilterState() {
  return {
    url: "",
    dateStart: "",
    dateEnd: "",
    devices: new Set()
  };
}

function activeArchiveFilters() {
  return archiveFiltersByPlatform[activePlatform];
}

function activeChangesFilters() {
  return changesFiltersByPlatform[activePlatform];
}

function setActivePlatform(platform, options = {}) {
  activePlatform = resolveActivePlatformValue(platform);
  syncPlatformTabs();
  syncActiveTabUi();
  syncActivePlatformFilterInputs();
  closePlatformMenus();
  if (options.render !== false) {
    render();
  }
}

function syncPlatformTabs() {
  for (const tab of elements.platformTabs) {
    const isActive = tab.dataset.platformTab === activePlatform;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  }
}

function resolveActivePlatformValue(platform) {
  return platform === "mobile" ? "mobile" : "pc";
}

function resolveAvailablePlatform(nextState, fallbackPlatform = activePlatform) {
  const currentPlatform = resolveActivePlatformValue(fallbackPlatform);
  const platformViews = nextState?.platforms;
  const availablePlatforms = ["pc", "mobile"].filter((platform) => platformViews?.[platform]);

  if (availablePlatforms.length === 0) {
    return currentPlatform;
  }

  if (availablePlatforms.includes(currentPlatform)) {
    return currentPlatform;
  }

  return availablePlatforms.includes("pc")
    ? "pc"
    : availablePlatforms[0];
}

function handlePlatformTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const currentIndex = elements.platformTabs.indexOf(event.currentTarget);
  const lastIndex = elements.platformTabs.length - 1;
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

  const nextTab = elements.platformTabs[nextIndex];
  setActivePlatform(nextTab.dataset.platformTab);
  nextTab.focus();
}

function syncActivePlatformFilterInputs() {
  const archiveFilters = activeArchiveFilters();
  const changeFilters = activeChangesFilters();
  elements.urlFilter.value = archiveFilters.url;
  elements.dateStartFilter.value = archiveFilters.dateStart;
  elements.dateEndFilter.value = archiveFilters.dateEnd;
  elements.changesUrlFilter.value = changeFilters.url;
  elements.changesDateStartFilter.value = changeFilters.dateStart;
  elements.changesDateEndFilter.value = changeFilters.dateEnd;
}

function closePlatformMenus() {
  setDeviceFilterMenuOpen(false);
  setChangesDeviceFilterMenuOpen(false);
}

function activeTabForPlatform(platform = activePlatform) {
  return activeTabByPlatform[resolveActivePlatformValue(platform)] === "changes"
    ? "changes"
    : "archive";
}

function resolveActiveTabValue(tabName) {
  return tabName === "changes" ? "changes" : "archive";
}

function setActiveTab(tabName, options = {}) {
  activeTabByPlatform[activePlatform] = resolveActiveTabValue(tabName);
  syncActiveTabUi();

  const activeTab = activeTabForPlatform();
  if (activeTab !== "archive") {
    setDeviceFilterMenuOpen(false);
  }
  if (activeTab !== "changes") {
    setChangesDeviceFilterMenuOpen(false);
  }

  if (options.render !== false) {
    render();
  }
}

function syncActiveTabUi() {
  const activeTab = activeTabForPlatform();

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

async function refreshState(options = {}) {
  const [stateResponse, changesResponse] = await Promise.all([
    fetch("/api/state"),
    fetch("/api/changes")
  ]);
  state = await stateResponse.json();
  const loadedChanges = await changesResponse.json();
  changes = Array.isArray(loadedChanges) ? loadedChanges : [];
  setActivePlatform(resolveAvailablePlatform(state, activePlatform), { render: false });
  render(options);
}

function render(options = {}) {
  const platformView = state.platforms?.[activePlatform] || null;
  elements.platformState.textContent = platformView?.label || platformLabel(activePlatform);
  elements.shotCount.textContent = platformSnapshots().length;
  elements.changeCount.textContent = platformChanges().length;
  elements.captureState.textContent = state.capture.running ? "截图中" : "空闲";
  elements.browserState.textContent = state.browser.ok ? browserName(state.browser.path) : "未找到";
  elements.scheduleState.textContent = "整点（所有设备）";
  const latestCapturedAt = latestSnapshotCapturedAt();
  elements.latestShotTime.textContent = latestCapturedAt
    ? `最近一次截图时间：${formatDate(latestCapturedAt)}`
    : "最近一次截图时间：暂无";
  elements.captureState.textContent = state.capture.running ? "截图中" : "空闲";
  elements.browserState.textContent = state.browser.ok ? browserName(state.browser.path) : "未找到";
  elements.scheduleState.textContent = scheduleLabelForActivePlatform(platformView);
  elements.latestShotTime.textContent = latestSnapshotCapturedAt()
    ? `最近一次截图时间：${formatDate(latestSnapshotCapturedAt())}`
    : "最近一次截图时间：暂无";
  syncActivePlatformFilterInputs();
  renderFilterOptions();
  renderChangesFilterOptions();
  renderDeviceFilterOptions();
  renderChangesDeviceFilterOptions();
  renderArchiveStatus();
  renderChangesSummary();
  renderGallery({ preserveScroll: options.preserveScroll !== false });
}

function platformSnapshots() {
  return (state?.snapshots || []).filter((snapshot) =>
    platformForSnapshot(snapshot, state?.devicePresets || []) === activePlatform
  );
}

function platformChanges() {
  return changes.filter((change) =>
    platformForChange(change, state?.devicePresets || []) === activePlatform
  );
}

/*
function scheduleLabelForActivePlatform(platformView) {
  if (!platformView) {
    return "按启用计划执行";
  }

  const profileCount = Array.isArray(platformView.deviceProfiles)
    ? platformView.deviceProfiles.filter((profile) => profile.enabled !== false).length
    : 0;
  const targetCount = Array.isArray(platformView.targets) ? platformView.targets.length : 0;
  return `${platformView.label}：${targetCount} URL / ${profileCount} 设备配置`;
}

*/
function scheduleLabelForActivePlatform(platformView) {
  if (!platformView) {
    return "By enabled plans";
  }

  const profileCount = Array.isArray(platformView.deviceProfiles)
    ? platformView.deviceProfiles.filter((profile) => profile.enabled !== false).length
    : 0;
  const targetCount = Array.isArray(platformView.targets) ? platformView.targets.length : 0;
  return `${platformView.label}: ${targetCount} URL / ${profileCount} profiles`;
}

function renderArchiveStatus() {
  const message = String(archiveStatusState.message || "").trim();
  elements.archiveStatus.hidden = !message;
  elements.archiveStatus.textContent = message;
  elements.archiveStatus.classList.toggle("is-success", archiveStatusState.tone === "success");
  elements.archiveStatus.classList.toggle("is-error", archiveStatusState.tone === "error");
}

function setArchiveStatus(message = "", tone = "info") {
  archiveStatusState = {
    tone,
    message: String(message || "").trim()
  };
  renderArchiveStatus();
}

function latestSnapshotCapturedAt() {
  const latest = Math.max(...platformSnapshots().map((snapshot) => timestamp(snapshot.capturedAt)));
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function renderFilterOptions() {
  renderUrlFilterOptions(elements.urlFilter, urlFilterOptions(), activeArchiveFilters().url);
}

function renderChangesFilterOptions() {
  renderUrlFilterOptions(elements.changesUrlFilter, urlFilterOptions(), activeChangesFilters().url);
}

function renderUrlFilterOptions(select, urls, currentValue = "") {
  const current = currentValue;
  select.innerHTML = "<option value=\"\">全部 URL</option>";
  for (const url of urls) {
    const option = document.createElement("option");
    option.value = url;
    option.textContent = url;
    select.append(option);
  }
  select.value = urls.includes(current) ? current : "";
}

function renderDeviceFilterOptions() {
  renderDeviceFilterOptionsFor({
    devices: uniqueDevicesFromSnapshots(),
    selectedFilters: activeArchiveFilters(),
    menu: elements.deviceFilterMenu,
    label: elements.deviceFilterLabel,
    button: elements.deviceFilterButton,
    allLabel: "全部截图设备"
  });
}

function renderChangesDeviceFilterOptions() {
  renderDeviceFilterOptionsFor({
    devices: uniqueDevicesFromChanges(),
    selectedFilters: activeChangesFilters(),
    menu: elements.changesDeviceFilterMenu,
    label: elements.changesDeviceFilterLabel,
    button: elements.changesDeviceFilterButton,
    allLabel: "全部截图设备"
  });
}

function renderDeviceFilterOptionsFor({ devices, selectedFilters, menu, label, button, allLabel }) {
  const availableDeviceIds = new Set(devices.map((device) => device.id));
  selectedFilters.devices = new Set(
    [...selectedFilters.devices].filter((id) => availableDeviceIds.has(id))
  );

  const groups = deviceFilterGroups(devices);
  menu.innerHTML = "";

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
    categoryInput.checked = group.devices.every((device) => selectedFilters.devices.has(device.id));

    const options = section.querySelector(".device-filter-options");
    for (const device of group.devices) {
      const label = document.createElement("label");
      label.className = "device-filter-check";
      label.innerHTML = `
        <input type="checkbox" data-filter-type="device" value="${escapeHtml(device.id)}">
        <span>${escapeHtml(device.name)}</span>
      `;
      label.querySelector("input").checked = selectedFilters.devices.has(device.id);
      options.append(label);
    }

    menu.append(section);
  }

  const actions = document.createElement("div");
  actions.className = "device-filter-actions";
  actions.innerHTML = "<button type=\"button\" data-filter-action=\"clear\">清除</button>";
  menu.append(actions);
  renderDeviceFilterLabel(devices, selectedFilters, label, button, allLabel);
}

function toggleDeviceFilterMenu() {
  toggleDeviceFilterMenuFor(elements.deviceFilter, elements.deviceFilterButton);
}

function toggleChangesDeviceFilterMenu() {
  toggleDeviceFilterMenuFor(elements.changesDeviceFilter, elements.changesDeviceFilterButton);
}

function toggleDeviceFilterMenuFor(filter, button) {
  const isOpen = filter.dataset.open === "true";
  setDeviceFilterMenuOpenFor(filter, button, !isOpen);
}

function setDeviceFilterMenuOpen(isOpen) {
  setDeviceFilterMenuOpenFor(elements.deviceFilter, elements.deviceFilterButton, isOpen);
}

function setChangesDeviceFilterMenuOpen(isOpen) {
  setDeviceFilterMenuOpenFor(elements.changesDeviceFilter, elements.changesDeviceFilterButton, isOpen);
}

function setDeviceFilterMenuOpenFor(filter, button, isOpen) {
  filter.dataset.open = isOpen ? "true" : "false";
  button.setAttribute("aria-expanded", String(isOpen));
}

function closeDeviceFilterOnOutsideClick(event) {
  if (!elements.deviceFilter.contains(event.target)) {
    setDeviceFilterMenuOpen(false);
  }
  if (!elements.changesDeviceFilter.contains(event.target)) {
    setChangesDeviceFilterMenuOpen(false);
  }
}

function closeDeviceFilterOnEscape(event) {
  if (event.key === "Escape") {
    setDeviceFilterMenuOpen(false);
    setChangesDeviceFilterMenuOpen(false);
  }
}

function handleImagePreviewClick(event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  const link = event.target.closest(".shot-main-image, .related-thumb, .change-image");
  if (!link || !link.href) {
    return;
  }

  event.preventDefault();
  openImagePreview({
    item: imagePreviewItemFromLink(link),
    navigation: link.classList.contains("related-thumb") ? imagePreviewNavigationForRelatedThumb(link) : null,
    trigger: link
  });
}

function imagePreviewCaptionForLink(link) {
  const image = link.querySelector("img");
  return image?.getAttribute("alt") || link.getAttribute("title") || link.href;
}

function imagePreviewItemFromLink(link) {
  return {
    src: link.href,
    caption: imagePreviewCaptionForLink(link),
    snapshot: previewSnapshotForLink(link)
  };
}

function previewSnapshotForLink(link) {
  if (!link) {
    return null;
  }
  if (link.classList.contains("shot-main-image")) {
    return snapshotForPreviewLink(link);
  }
  if (link.classList.contains("related-thumb")) {
    return relatedShotSnapshotForPreviewLink(link);
  }
  return null;
}

function imagePreviewNavigationForRelatedThumb(link) {
  const card = link.closest(".shot");
  if (!card) {
    return null;
  }

  const links = [...card.querySelectorAll(".related-thumb[href]")];
  if (!links.length) {
    return null;
  }

  return {
    items: links.map((item) => imagePreviewItemFromLink(item)),
    index: Math.max(0, links.indexOf(link))
  };
}

function createImagePreviewZoomState() {
  return {
    naturalWidth: 0,
    naturalHeight: 0,
    scale: 1,
    fitScale: 1,
    isFit: true,
    dragging: false,
    dragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragStartScrollLeft: 0,
    dragStartScrollTop: 0,
    snapshot: null,
    comparison: null
  };
}

function createImagePreviewNavigationState() {
  return {
    items: [],
    index: -1
  };
}

function openImagePreview({ item, navigation = null, trigger }) {
  imagePreviewReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  const wasHidden = elements.imagePreview.hidden;
  const caption = item?.caption || "";
  elements.imagePreviewImage.alt = caption || "图片预览";
  elements.imagePreviewCaption.textContent = caption || "";
  if (wasHidden) {
    imagePreviewPreviousOverflow = document.body.style.overflow || "";
    elements.imagePreview.hidden = false;
    elements.imagePreview.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  setImagePreviewNavigation(navigation);
  showImagePreviewItem(currentImagePreviewNavigationItem() || item);

  if (wasHidden) {
    elements.imagePreviewClose.focus();
  }
}

function showImagePreviewItem(item) {
  resetImagePreviewZoom();
  imagePreviewZoomState.snapshot = item?.snapshot || null;
  elements.imagePreviewImage.src = item?.src || "";
  elements.imagePreviewImage.alt = item?.caption || "鍥剧墖棰勮";
  elements.imagePreviewCaption.textContent = item?.caption || "";
  syncImagePreviewNavigationControls();
  requestAnimationFrame(() => {
    if (elements.imagePreviewImage.complete && elements.imagePreviewImage.naturalWidth) {
      handleImagePreviewImageLoad();
    }
  });
}

function setImagePreviewNavigation(navigation = null) {
  const items = Array.isArray(navigation?.items)
    ? navigation.items.filter((item) => item?.src)
    : [];
  const total = items.length;
  imagePreviewNavigationState = {
    items,
    index: total ? wrapImagePreviewNavigationIndex(Number(navigation?.index || 0), total) : -1
  };
  syncImagePreviewNavigationControls();
}

function clearImagePreviewNavigation() {
  imagePreviewNavigationState = createImagePreviewNavigationState();
  syncImagePreviewNavigationControls();
}

function currentImagePreviewNavigationItem() {
  if (!hasImagePreviewNavigation()) {
    return null;
  }
  return imagePreviewNavigationState.items[imagePreviewNavigationState.index] || null;
}

function hasImagePreviewNavigation() {
  return imagePreviewNavigationState.items.length > 0;
}

function canStepImagePreviewNavigation() {
  return imagePreviewNavigationState.items.length > 1;
}

function syncImagePreviewNavigationControls() {
  const hasNavigation = hasImagePreviewNavigation();
  const canStep = canStepImagePreviewNavigation();
  elements.imagePreviewNavControls.hidden = !hasNavigation;
  elements.imagePreviewPrev.disabled = !canStep;
  elements.imagePreviewNext.disabled = !canStep;
}

function stepImagePreviewNavigation(delta) {
  if (!canStepImagePreviewNavigation()) {
    return;
  }

  const total = imagePreviewNavigationState.items.length;
  imagePreviewNavigationState.index = wrapImagePreviewNavigationIndex(imagePreviewNavigationState.index + delta, total);
  showImagePreviewItem(imagePreviewNavigationState.items[imagePreviewNavigationState.index]);
}

function wrapImagePreviewNavigationIndex(index, total) {
  if (!Number.isFinite(total) || total <= 0) {
    return -1;
  }

  const value = Number(index || 0);
  return ((value % total) + total) % total;
}

function handleImagePreviewNavigationKeydown(event) {
  if (elements.imagePreview.hidden || event.defaultPrevented) {
    return;
  }

  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    return;
  }

  if (!canStepImagePreviewNavigation()) {
    return;
  }

  event.preventDefault();
  stepImagePreviewNavigation(event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
}

function closeImagePreview() {
  if (elements.imagePreview.hidden) {
    return;
  }

  elements.imagePreview.hidden = true;
  elements.imagePreview.setAttribute("aria-hidden", "true");
  endImagePreviewDrag();
  elements.imagePreviewImage.removeAttribute("src");
  elements.imagePreviewImage.removeAttribute("style");
  elements.imagePreviewCaption.textContent = "";
  clearImagePreviewNavigation();
  resetImagePreviewZoom();
  document.body.style.overflow = imagePreviewPreviousOverflow;
  const returnFocus = imagePreviewReturnFocus;
  imagePreviewReturnFocus = null;
  if (returnFocus?.isConnected) {
    returnFocus.focus();
  }
}

function resetImagePreviewZoom() {
  imagePreviewZoomState = createImagePreviewZoomState();
  elements.imagePreviewImage.removeAttribute("style");
  elements.imagePreviewLongView.dataset.mode = "single";
  elements.imagePreviewLongView.removeAttribute("style");
  elements.imagePreviewMainFrame.removeAttribute("style");
  elements.imagePreviewDepthMarkers.innerHTML = "";
  elements.imagePreviewScreenRail.innerHTML = "";
  elements.imagePreviewViewport.scrollLeft = 0;
  elements.imagePreviewViewport.scrollTop = 0;
  elements.imagePreviewViewport.classList.remove("can-drag", "is-dragging");
  updateImagePreviewZoomControls();
}

function handleImagePreviewImageLoad() {
  if (elements.imagePreview.hidden || !elements.imagePreviewImage.naturalWidth) {
    return;
  }

  imagePreviewZoomState.naturalWidth = elements.imagePreviewImage.naturalWidth;
  imagePreviewZoomState.naturalHeight = elements.imagePreviewImage.naturalHeight;
  imagePreviewZoomState.comparison = imagePreviewComparisonForSnapshot(imagePreviewZoomState.snapshot);
  renderImagePreviewMode();
  fitImagePreviewToViewport();
}

function renderImagePreviewMode() {
  const comparison = imagePreviewZoomState.comparison;
  elements.imagePreviewLongView.dataset.mode = comparison ? "comparison" : "single";
  elements.imagePreviewDepthMarkers.innerHTML = "";
  elements.imagePreviewScreenRail.innerHTML = "";

  if (comparison) {
    renderImagePreviewDepthMarkers(comparison, imagePreviewMarkerModeForSnapshot(imagePreviewZoomState.snapshot));
    renderImagePreviewScreenRail(comparison);
  }

  applyImagePreviewScale(imagePreviewZoomState.scale || 1);
}

function renderImagePreviewDepthMarkers(comparison, mode = "percent-depth") {
  if (mode === "screen-dividers") {
    const naturalHeight = Math.max(1, Number(imagePreviewZoomState.naturalHeight || 0));
    for (const segment of comparison?.segments || []) {
      const marker = document.createElement("div");
      marker.className = [
        "image-preview-depth-marker",
        "is-screen-divider",
        segment.index === 1 ? "is-first-screen" : ""
      ].filter(Boolean).join(" ");
      marker.style.top = `${Math.max(0, Math.min(100, (segment.y / naturalHeight) * 100))}%`;

      const label = document.createElement("span");
      label.textContent = `第${segment.index}屏`;
      marker.append(label);
      elements.imagePreviewDepthMarkers.append(marker);
    }
    return;
  }

  for (let depth = 10; depth <= 100; depth += 10) {
    const marker = document.createElement("div");
    marker.className = [
      "image-preview-depth-marker",
      depth === 100 ? "is-bottom" : ""
    ].filter(Boolean).join(" ");
    if (depth < 100) {
      marker.style.top = `${depth}%`;
    }

    const label = document.createElement("span");
    label.textContent = `${depth}%`;
    marker.append(label);
    elements.imagePreviewDepthMarkers.append(marker);
  }
}

function renderImagePreviewScreenRail(comparison) {
  const imageUrl = elements.imagePreviewImage.currentSrc || elements.imagePreviewImage.src;
  const fragment = document.createDocumentFragment();

  for (const segment of comparison.segments) {
    const screen = document.createElement("div");
    screen.className = "image-preview-screen";
    screen.dataset.y = String(segment.y);
    screen.dataset.height = String(segment.height);
    screen.style.backgroundImage = cssUrl(imageUrl);
    screen.setAttribute("aria-label", `第 ${segment.index} 屏`);

    const label = document.createElement("span");
    label.textContent = `第 ${segment.index} 屏`;
    screen.append(label);
    fragment.append(screen);
  }

  elements.imagePreviewScreenRail.append(fragment);
}

function imagePreviewMarkerModeForSnapshot(snapshot) {
  return snapshot?.sectionKey === "navigation" ? "screen-dividers" : "percent-depth";
}

function applyImagePreviewScale(scale) {
  if (!imagePreviewZoomState.naturalWidth || !imagePreviewZoomState.naturalHeight) {
    return;
  }

  const imageWidth = imagePreviewZoomState.naturalWidth * scale;
  const imageHeight = imagePreviewZoomState.naturalHeight * scale;
  elements.imagePreviewImage.style.width = `${imageWidth}px`;
  elements.imagePreviewImage.style.height = `${imageHeight}px`;
  elements.imagePreviewMainFrame.style.width = `${imageWidth}px`;
  elements.imagePreviewMainFrame.style.height = `${imageHeight}px`;

  if (!imagePreviewZoomState.comparison) {
    elements.imagePreviewLongView.removeAttribute("style");
    elements.imagePreviewScreenRail.removeAttribute("style");
    return;
  }

  elements.imagePreviewLongView.style.columnGap = `${imagePreviewScreenRailGap * scale}px`;
  elements.imagePreviewScreenRail.style.width = `${imageWidth}px`;

  for (const screen of elements.imagePreviewScreenRail.querySelectorAll(".image-preview-screen")) {
    const y = Number(screen.dataset.y || 0);
    const height = Number(screen.dataset.height || 0);
    screen.style.width = `${imageWidth}px`;
    screen.style.height = `${height * scale}px`;
    screen.style.backgroundSize = `${imageWidth}px ${imageHeight}px`;
    screen.style.backgroundPosition = `0 -${y * scale}px`;
  }
}

function imagePreviewContentNaturalSize() {
  const width = imagePreviewZoomState.naturalWidth || 1;
  const height = imagePreviewZoomState.naturalHeight || 1;
  return {
    width: imagePreviewZoomState.comparison ? width * 2 + imagePreviewScreenRailGap : width,
    height
  };
}

function imagePreviewFitScaleForViewport(viewportWidth, viewportHeight) {
  const contentSize = imagePreviewContentNaturalSize();
  const widthScale = viewportWidth / contentSize.width;
  const heightScale = viewportHeight / contentSize.height;
  const fitScale = imagePreviewZoomState.comparison
    ? widthScale
    : Math.min(widthScale, heightScale);
  return Math.min(fitScale, 1);
}

function imagePreviewComparisonForSnapshot(snapshot) {
  if (!snapshot || !imagePreviewZoomState.naturalHeight) {
    return null;
  }

  const viewportHeight = imagePreviewViewportHeightForSnapshot(snapshot);
  const naturalHeight = imagePreviewZoomState.naturalHeight;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0 || naturalHeight <= viewportHeight + 2) {
    return null;
  }

  const segments = [];
  for (let y = 0, index = 1; y < naturalHeight - 1 && segments.length < 200; y += viewportHeight, index += 1) {
    segments.push({
      index,
      y,
      height: Math.min(viewportHeight, naturalHeight - y)
    });
  }

  return segments.length > 1
    ? { viewportHeight, segments }
    : null;
}

function imagePreviewViewportHeightForSnapshot(snapshot) {
  const scrollViewportHeight = Number(snapshot?.scrollInfo?.viewportHeight || 0);
  if (Number.isFinite(scrollViewportHeight) && scrollViewportHeight > 0) {
    return scrollViewportHeight;
  }

  const preset = (state?.devicePresets || []).find((item) => item.id === snapshot?.devicePresetId);
  const presetHeight = Number(preset?.height || 0);
  return Number.isFinite(presetHeight) && presetHeight > 0 ? presetHeight : null;
}

function snapshotForPreviewLink(link) {
  if (!link || !state?.snapshots?.length) {
    return null;
  }

  const snapshotId = link.dataset.snapshotId || "";
  if (snapshotId) {
    const byId = state.snapshots.find((snapshot) => snapshot.id === snapshotId);
    if (byId) {
      return byId;
    }
  }

  const snapshotFile = link.dataset.snapshotFile || "";
  if (snapshotFile) {
    const byFile = state.snapshots.find((snapshot) => snapshot.file === snapshotFile);
    if (byFile) {
      return byFile;
    }
  }

  const hrefPath = safePathname(link.href);
  return state.snapshots.find((snapshot) => safePathname(snapshot.imageUrl) === hrefPath) || null;
}

function relatedShotSnapshotForPreviewLink(link) {
  if (!link) {
    return null;
  }

  const card = link.closest(".shot");
  const mainLink = card?.querySelector(".shot-main-image");
  const parentSnapshot = snapshotForPreviewLink(mainLink);
  const width = Number(link.dataset.previewWidth || 0) || parentSnapshot?.width || 0;
  const height = Number(link.dataset.previewHeight || 0) || parentSnapshot?.height || 0;
  const scrollViewportHeight = Number(
    link.dataset.previewViewportHeight ||
    card?.dataset.viewportHeight ||
    parentSnapshot?.scrollInfo?.viewportHeight ||
    0
  );

  if (!width || !height) {
    return parentSnapshot || null;
  }

  return {
    ...(parentSnapshot || {}),
    file: link.dataset.shotFile || parentSnapshot?.file || "",
    imageUrl: link.href,
    width,
    height,
    devicePresetId: parentSnapshot?.devicePresetId || card?.dataset.devicePresetId || null,
    sectionKey: link.dataset.sectionKey || parentSnapshot?.sectionKey || null,
    navigationLevel: link.dataset.navigationLevel || parentSnapshot?.navigationLevel || null,
    scrollInfo: Number.isFinite(scrollViewportHeight) && scrollViewportHeight > 0
      ? {
          ...(parentSnapshot?.scrollInfo || {}),
          viewportHeight: scrollViewportHeight
        }
      : parentSnapshot?.scrollInfo || null
  };
}

function safePathname(value) {
  try {
    return new URL(value, window.location.href).pathname;
  } catch {
    return String(value || "");
  }
}

function cssUrl(value) {
  return `url("${String(value || "").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}")`;
}

function fitImagePreviewToViewport() {
  if (!imagePreviewZoomState.naturalWidth || !imagePreviewZoomState.naturalHeight) {
    return;
  }

  const viewportWidth = Math.max(1, elements.imagePreviewViewport.clientWidth);
  const viewportHeight = Math.max(1, elements.imagePreviewViewport.clientHeight);
  const fitScale = imagePreviewFitScaleForViewport(viewportWidth, viewportHeight);

  imagePreviewZoomState.fitScale = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
  setImagePreviewScale(imagePreviewZoomState.fitScale, { fit: true });
}

function changeImagePreviewZoom(direction) {
  if (!imagePreviewZoomState.naturalWidth) {
    return;
  }

  const factor = direction > 0 ? imagePreviewButtonScaleStep : 1 / imagePreviewButtonScaleStep;
  const rect = elements.imagePreviewViewport.getBoundingClientRect();
  setImagePreviewScale(imagePreviewZoomState.scale * factor, {
    anchorX: rect.left + rect.width / 2,
    anchorY: rect.top + rect.height / 2
  });
}

function handleImagePreviewWheel(event) {
  if (!imagePreviewZoomState.naturalWidth) {
    return;
  }

  event.preventDefault();
  if (!event.deltaY) {
    return;
  }

  const factor = Math.pow(imagePreviewWheelScaleStep, -event.deltaY / 100);
  setImagePreviewScale(imagePreviewZoomState.scale * factor, {
    anchorX: event.clientX,
    anchorY: event.clientY
  });
}

function setImagePreviewScale(nextScale, { anchorX = null, anchorY = null, fit = false } = {}) {
  if (!imagePreviewZoomState.naturalWidth || !imagePreviewZoomState.naturalHeight) {
    return;
  }

  const previousScale = imagePreviewZoomState.scale || 1;
  const scale = clampImagePreviewScale(nextScale);
  const viewport = elements.imagePreviewViewport;
  const rect = viewport.getBoundingClientRect();
  const hasAnchor = Number.isFinite(anchorX) && Number.isFinite(anchorY);
  const anchorViewportX = hasAnchor ? anchorX - rect.left : rect.width / 2;
  const anchorViewportY = hasAnchor ? anchorY - rect.top : rect.height / 2;
  const anchorContentX = (viewport.scrollLeft + anchorViewportX) / previousScale;
  const anchorContentY = (viewport.scrollTop + anchorViewportY) / previousScale;

  imagePreviewZoomState.scale = scale;
  imagePreviewZoomState.isFit = Boolean(fit);
  applyImagePreviewScale(scale);
  updateImagePreviewZoomControls();

  requestAnimationFrame(() => {
    if (fit) {
      centerImagePreviewViewport();
    } else {
      viewport.scrollLeft = anchorContentX * scale - anchorViewportX;
      viewport.scrollTop = anchorContentY * scale - anchorViewportY;
    }
    updateImagePreviewZoomControls();
  });
}

function clampImagePreviewScale(scale) {
  const minScale = Math.min(imagePreviewDefaultMinScale, imagePreviewZoomState.fitScale || imagePreviewDefaultMinScale);
  const boundedScale = Math.min(imagePreviewMaxScale, Math.max(minScale, scale));
  return Number.isFinite(boundedScale) && boundedScale > 0 ? boundedScale : 1;
}

function centerImagePreviewViewport() {
  const viewport = elements.imagePreviewViewport;
  viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
  viewport.scrollTop = imagePreviewZoomState.comparison
    ? 0
    : Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
}

function updateImagePreviewZoomControls() {
  const hasImage = Boolean(imagePreviewZoomState.naturalWidth);
  const minScale = Math.min(imagePreviewDefaultMinScale, imagePreviewZoomState.fitScale || imagePreviewDefaultMinScale);
  elements.imagePreviewZoomOut.disabled = !hasImage || imagePreviewZoomState.scale <= minScale + 0.001;
  elements.imagePreviewZoomIn.disabled = !hasImage || imagePreviewZoomState.scale >= imagePreviewMaxScale - 0.001;
  elements.imagePreviewZoomFit.disabled = !hasImage || Math.abs(imagePreviewZoomState.scale - imagePreviewZoomState.fitScale) <= 0.001;
  elements.imagePreviewZoomValue.textContent = hasImage ? `${Math.round(imagePreviewZoomState.scale * 100)}%` : "100%";

  const canDrag = hasImage && (
    elements.imagePreviewViewport.scrollWidth > elements.imagePreviewViewport.clientWidth + 1 ||
    elements.imagePreviewViewport.scrollHeight > elements.imagePreviewViewport.clientHeight + 1
  );
  elements.imagePreviewViewport.classList.toggle("can-drag", canDrag && !elements.imagePreview.hidden);
}

function startImagePreviewDrag(event) {
  if (event.button !== 0 || !imagePreviewZoomState.naturalWidth) {
    return;
  }

  const canDrag = elements.imagePreviewViewport.scrollWidth > elements.imagePreviewViewport.clientWidth + 1 ||
    elements.imagePreviewViewport.scrollHeight > elements.imagePreviewViewport.clientHeight + 1;
  if (!canDrag) {
    return;
  }

  imagePreviewZoomState.dragging = true;
  imagePreviewZoomState.dragPointerId = event.pointerId;
  imagePreviewZoomState.dragStartX = event.clientX;
  imagePreviewZoomState.dragStartY = event.clientY;
  imagePreviewZoomState.dragStartScrollLeft = elements.imagePreviewViewport.scrollLeft;
  imagePreviewZoomState.dragStartScrollTop = elements.imagePreviewViewport.scrollTop;
  elements.imagePreviewViewport.classList.add("is-dragging");
  elements.imagePreviewViewport.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveImagePreviewDrag(event) {
  if (!imagePreviewZoomState.dragging || imagePreviewZoomState.dragPointerId !== event.pointerId) {
    return;
  }

  elements.imagePreviewViewport.scrollLeft = imagePreviewZoomState.dragStartScrollLeft - (event.clientX - imagePreviewZoomState.dragStartX);
  elements.imagePreviewViewport.scrollTop = imagePreviewZoomState.dragStartScrollTop - (event.clientY - imagePreviewZoomState.dragStartY);
  event.preventDefault();
}

function endImagePreviewDrag(event) {
  if (event && imagePreviewZoomState.dragPointerId !== event.pointerId) {
    return;
  }

  if (imagePreviewZoomState.dragPointerId !== null && elements.imagePreviewViewport.hasPointerCapture?.(imagePreviewZoomState.dragPointerId)) {
    elements.imagePreviewViewport.releasePointerCapture(imagePreviewZoomState.dragPointerId);
  }
  imagePreviewZoomState.dragging = false;
  imagePreviewZoomState.dragPointerId = null;
  elements.imagePreviewViewport.classList.remove("is-dragging");
}

function handleImagePreviewResize() {
  if (elements.imagePreview.hidden || !imagePreviewZoomState.naturalWidth) {
    return;
  }

  const wasFit = imagePreviewZoomState.isFit;
  const previousScale = imagePreviewZoomState.scale;
  const viewportWidth = Math.max(1, elements.imagePreviewViewport.clientWidth);
  const viewportHeight = Math.max(1, elements.imagePreviewViewport.clientHeight);
  const nextFitScale = imagePreviewFitScaleForViewport(viewportWidth, viewportHeight);
  imagePreviewZoomState.fitScale = Number.isFinite(nextFitScale) && nextFitScale > 0 ? nextFitScale : 1;

  if (wasFit) {
    setImagePreviewScale(imagePreviewZoomState.fitScale, { fit: true });
    return;
  }

  const rect = elements.imagePreviewViewport.getBoundingClientRect();
  setImagePreviewScale(previousScale, {
    anchorX: rect.left + rect.width / 2,
    anchorY: rect.top + rect.height / 2
  });
}

function handleImagePreviewBackdropClick(event) {
  if (event.target === elements.imagePreview) {
    closeImagePreview();
  }
}

function closeImagePreviewOnEscape(event) {
  if (event.key === "Escape") {
    closeImagePreview();
  }
}

function openWarningPreview({ title, warnings, trigger }) {
  warningPreviewReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  warningPreviewPreviousOverflow = document.body.style.overflow || "";
  elements.warningPreviewTitle.textContent = title || "更多截图校验警告";
  elements.warningPreviewList.innerHTML = warnings.length
    ? warnings.map((warning) => `
      <li>
        <strong>${escapeHtml(warning.scope || "更多截图")}</strong>
        <span>${escapeHtml(warning.message || "校验警告")}</span>
      </li>
    `).join("")
    : "<li><strong>更多截图</strong><span>暂无校验明细</span></li>";
  elements.warningPreview.hidden = false;
  elements.warningPreview.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  elements.warningPreviewClose.focus();
}

function closeWarningPreview() {
  if (elements.warningPreview.hidden) {
    return;
  }

  elements.warningPreview.hidden = true;
  elements.warningPreview.setAttribute("aria-hidden", "true");
  elements.warningPreviewList.innerHTML = "";
  document.body.style.overflow = warningPreviewPreviousOverflow;
  const returnFocus = warningPreviewReturnFocus;
  warningPreviewReturnFocus = null;
  if (returnFocus?.isConnected) {
    returnFocus.focus();
  }
}

function handleWarningPreviewBackdropClick(event) {
  if (event.target === elements.warningPreview) {
    closeWarningPreview();
  }
}

function closeWarningPreviewOnEscape(event) {
  if (event.key === "Escape") {
    closeWarningPreview();
  }
}

function warningPayload(warnings) {
  return encodeURIComponent(JSON.stringify(warnings.map((warning) => ({
    scope: relatedWarningScope(warning),
    message: relatedWarningMessage(warning)
  }))));
}

function parseWarningPayload(value) {
  try {
    const parsed = JSON.parse(decodeURIComponent(value || ""));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function handleDeviceFilterClick(event) {
  handleDeviceFilterClickFor(event, {
    selectedFilters: activeArchiveFilters(),
    renderOptions: renderDeviceFilterOptions,
    renderResults: () => renderGallery({ preserveScroll: false })
  });
}

function handleChangesDeviceFilterClick(event) {
  handleDeviceFilterClickFor(event, {
    selectedFilters: activeChangesFilters(),
    renderOptions: renderChangesDeviceFilterOptions,
    renderResults: () => renderChangesSummary({ resetPage: true })
  });
}

function handleDeviceFilterClickFor(event, { selectedFilters, renderOptions, renderResults }) {
  const action = event.target.closest("[data-filter-action]")?.dataset.filterAction;
  if (action !== "clear") {
    return;
  }
  selectedFilters.devices.clear();
  renderOptions();
  renderResults();
}

function handleDeviceFilterChange(event) {
  handleDeviceFilterChangeFor(event, {
    selectedFilters: activeArchiveFilters(),
    devices: uniqueDevicesFromSnapshots,
    renderOptions: renderDeviceFilterOptions,
    renderResults: () => renderGallery({ preserveScroll: false })
  });
}

function handleChangesDeviceFilterChange(event) {
  handleDeviceFilterChangeFor(event, {
    selectedFilters: activeChangesFilters(),
    devices: uniqueDevicesFromChanges,
    renderOptions: renderChangesDeviceFilterOptions,
    renderResults: () => renderChangesSummary({ resetPage: true })
  });
}

function handleDeviceFilterChangeFor(event, { selectedFilters, devices, renderOptions, renderResults }) {
  const input = event.target.closest("input[type='checkbox']");
  if (!input) {
    return;
  }

  if (input.dataset.filterType === "category") {
    const group = deviceFilterGroups(devices()).find((item) => item.id === input.value);
    const deviceIds = group?.devices.map((device) => device.id) || [];
    for (const deviceId of deviceIds) {
      if (input.checked) {
        selectedFilters.devices.add(deviceId);
      } else {
        selectedFilters.devices.delete(deviceId);
      }
    }
  } else if (input.checked) {
    selectedFilters.devices.add(input.value);
  } else {
    selectedFilters.devices.delete(input.value);
  }

  renderOptions();
  renderResults();
}

function handleGalleryClick(event) {
  const deleteButton = event.target.closest("[data-action='delete-snapshot']");
  if (deleteButton && elements.gallery.contains(deleteButton)) {
    event.preventDefault();
    void handleSnapshotDeleteClick(deleteButton);
    return;
  }

  handleImagePreviewClick(event);
  if (event.defaultPrevented) {
    return;
  }

  const warning = event.target.closest(".related-warning");
  if (!warning || !elements.gallery.contains(warning)) {
    return;
  }

  openWarningPreview({
    title: warning.dataset.warningTitle || "更多截图校验警告",
    warnings: parseWarningPayload(warning.dataset.warningItems),
    trigger: warning
  });
}

async function handleSnapshotDeleteClick(button) {
  if (!(button instanceof HTMLButtonElement) || button.disabled) {
    return;
  }

  const snapshotId = String(button.dataset.snapshotId || "").trim();
  const snapshot = state?.snapshots?.find((item) => item.id === snapshotId);
  if (!snapshot) {
    setArchiveStatus("找不到要删除的截图记录，请先刷新页面。", "error");
    return;
  }

  const displayUrl = canonicalDisplayUrlForSnapshot(snapshot);
  if (!window.confirm([
    "删除这次截图？",
    "",
    `URL：${displayUrl}`,
    `设备：${deviceNameForSnapshot(snapshot)}`,
    `截图时间：${formatDate(snapshot.capturedAt)}`,
    "",
    "这会删除主图、相关小图，并重算变更汇总。"
  ].join("\n"))) {
    return;
  }

  pendingSnapshotDeletes.add(snapshotId);
  setArchiveStatus(`正在删除 ${displayUrl} 的截图...`);
  renderGallery({ preserveScroll: true });

  try {
    const response = await fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: "DELETE"
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `删除失败（HTTP ${response.status}）`);
    }

    setArchiveStatus(`已删除 ${displayUrl} ${formatDate(snapshot.capturedAt)} 的截图。`, "success");
    await refreshState({ preserveScroll: true });
  } catch (error) {
    setArchiveStatus(error?.message || "删除失败，请稍后重试。", "error");
  } finally {
    pendingSnapshotDeletes.delete(snapshotId);
    renderGallery({ preserveScroll: true });
  }
}

function renderDeviceFilterLabel(devices, selectedFilters, labelElement, button, allLabel) {
  const selectedDevices = devices.filter((device) => selectedFilters.devices.has(device.id));
  const label = selectedDevices.length === 0
    ? allLabel
    : `已选 ${selectedDevices.length} 项`;
  labelElement.textContent = label;
  button.title = selectedDevices.map((device) => device.name).join("、");
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
  return matchesDeviceFilterSet(deviceInfoForSnapshot(snapshot), activeArchiveFilters());
}

function matchesChangesDeviceFilters(change) {
  return matchesDeviceFilterSet(deviceInfoForChange(change), activeChangesFilters());
}

function matchesDeviceFilterSet(device, selectedFilters) {
  if (selectedFilters.devices.size === 0) {
    return true;
  }
  return selectedFilters.devices.has(device.id);
}

function matchesTimeFilter(snapshot) {
  return matchesDateRange(snapshot.capturedAt, selectedDateRange(activeArchiveFilters()));
}

function matchesChangesTimeFilter(change) {
  return matchesDateRange(changeTimeValue(change), selectedDateRange(activeChangesFilters()));
}

function changeTimeValue(change) {
  return change.to?.capturedAt || change.createdAt || change.occurredBetween?.to;
}

function matchesDateRange(value, range) {
  if (!range) {
    return true;
  }

  const capturedAt = timestamp(value);
  if (!capturedAt) {
    return false;
  }

  return capturedAt >= range.start && capturedAt <= range.end;
}

function selectedDateRange(filterState) {
  const start = startOfDay(filterState?.dateStart || "");
  const end = endOfDay(filterState?.dateEnd || "");

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
  clearDateFilterFor(activeArchiveFilters(), elements.dateStartFilter, elements.dateEndFilter, () => renderGallery({ preserveScroll: false }));
}

function clearChangesDateFilter() {
  clearDateFilterFor(activeChangesFilters(), elements.changesDateStartFilter, elements.changesDateEndFilter, () => renderChangesSummary({ resetPage: true }));
}

function clearDateFilterFor(filterState, startInput, endInput, renderResults) {
  filterState.dateStart = "";
  filterState.dateEnd = "";
  startInput.value = "";
  endInput.value = "";
  renderResults();
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

function renderChangesSummary(options = {}) {
  let changesPage = changesPageByPlatform[activePlatform] || 1;
  if (options.resetPage) {
    changesPage = 1;
  }
  const filteredChanges = platformChanges().filter(matchesChangeFilters);
  const totalPages = Math.max(1, Math.ceil(filteredChanges.length / changesPageSize));
  changesPage = Math.min(Math.max(changesPage, 1), totalPages);
  changesPageByPlatform[activePlatform] = changesPage;
  const pageStart = filteredChanges.length === 0 ? 0 : (changesPage - 1) * changesPageSize;
  const pageChanges = filteredChanges.slice(pageStart, pageStart + changesPageSize);
  elements.changesList.innerHTML = "";
  elements.changesEmpty.classList.toggle("visible", filteredChanges.length === 0);
  renderChangesPagination(filteredChanges.length, pageStart, pageChanges.length, totalPages);

  for (const change of pageChanges) {
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

function renderChangesPagination(total, pageStart, visibleCount, totalPages) {
  const changesPage = changesPageByPlatform[activePlatform] || 1;
  const hasMultiplePages = total > changesPageSize;
  elements.changesPagination.hidden = !hasMultiplePages;
  if (!hasMultiplePages) {
    elements.changesPaginationStatus.textContent = "";
    elements.changesPrevPage.disabled = true;
    elements.changesNextPage.disabled = true;
    return;
  }

  const firstVisible = pageStart + 1;
  const lastVisible = pageStart + visibleCount;
  elements.changesPaginationStatus.textContent = `第 ${changesPage} / ${totalPages} 页 · 显示 ${firstVisible}-${lastVisible} / ${total} 条`;
  elements.changesPrevPage.disabled = changesPage <= 1;
  elements.changesNextPage.disabled = changesPage >= totalPages;
}

function changeChangesPage(delta) {
  changesPageByPlatform[activePlatform] = (changesPageByPlatform[activePlatform] || 1) + delta;
  renderChangesSummary();
}

function matchesChangeFilters(change) {
  const selectedUrl = activeChangesFilters().url;
  const matchesUrl = selectedUrl ? canonicalDisplayUrlForChange(change) === selectedUrl : true;
  const matchesTime = matchesChangesTimeFilter(change);
  const matchesDevice = matchesChangesDeviceFilters(change);
  return matchesUrl && matchesTime && matchesDevice;
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
  if (signal?.type === "product-hover-item") {
    return signal.hoverItemLabel ? `Hover ${signal.hoverItemLabel}` : "Hover 交互态变化";
  }
  return {
    copy: "文案变化",
    image: "图片素材变化",
    layout: "内容位置明显变化",
    dimension: "图片尺寸变化",
    "media-item": signal.mediaItemLabel ? `媒体项变化：${signal.mediaItemLabel}` : "媒体项变化",
    "large-visual": "大面积视觉变化"
  }[signal.type] || signal.label || "";
}

function changeTitle(change) {
  if (change.location?.interactionState === "hover") {
    return [
      change.location?.displayUrl,
      change.location?.sectionLabel,
      change.location?.tabLabel,
      `Hover ${change.location?.hoverItemLabel || change.location?.label || ""}`.trim()
    ].filter(Boolean).join(" / ") || "页面变化";
  }
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

function renderGallery(options = {}) {
  const preserveScroll = options.preserveScroll !== false;
  const scrollState = preserveScroll ? captureGalleryScrollState() : null;
  const selectedUrl = activeArchiveFilters().url;
  const snapshots = platformSnapshots().filter((snapshot) => {
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

  restoreGalleryScrollState(scrollState);
}

function captureGalleryScrollState() {
  const relatedScroll = new Map();
  for (const related of elements.gallery.querySelectorAll(".shot-related[data-gallery-card-key]")) {
    const key = related.dataset.galleryCardKey;
    if (!key) {
      continue;
    }
    relatedScroll.set(key, {
      top: related.scrollTop,
      left: related.scrollLeft
    });
  }

  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    anchor: galleryScrollAnchor(),
    relatedScroll
  };
}

function galleryScrollAnchor() {
  const cards = [...elements.gallery.querySelectorAll(".shot[data-gallery-card-key]")];
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  let best = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= viewportHeight) {
      continue;
    }
    const distance = Math.abs(rect.top);
    if (!best || distance < best.distance) {
      best = {
        key: card.dataset.galleryCardKey,
        top: rect.top,
        distance
      };
    }
  }
  return best ? { key: best.key, top: best.top } : null;
}

function restoreGalleryScrollState(scrollState) {
  if (!scrollState) {
    return;
  }

  for (const related of elements.gallery.querySelectorAll(".shot-related[data-gallery-card-key]")) {
    const position = scrollState.relatedScroll.get(related.dataset.galleryCardKey);
    if (!position) {
      continue;
    }
    related.scrollTop = clampNumber(position.top, 0, Math.max(0, related.scrollHeight - related.clientHeight));
    related.scrollLeft = clampNumber(position.left, 0, Math.max(0, related.scrollWidth - related.clientWidth));
  }

  if (scrollState.anchor?.key) {
    const anchor = [...elements.gallery.querySelectorAll(".shot[data-gallery-card-key]")]
      .find((card) => card.dataset.galleryCardKey === scrollState.anchor.key);
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      window.scrollTo(scrollState.windowX, Math.max(0, window.scrollY + rect.top - scrollState.anchor.top));
      return;
    }
  }

  window.scrollTo(scrollState.windowX, Math.max(0, scrollState.windowY));
}

function clampNumber(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
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
      relatedShots: sortedRelatedShots(relatedShotsFromSnapshot(snapshot)),
      sortTime: timestamp(snapshot.capturedAt),
      homeGroup: false,
      relatedValidation: snapshot.relatedValidation || null
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
  if (relatedShot.file && relatedShot.file === group.snapshot.file) {
    return;
  }

  const key = relatedShotIdentityKey(relatedShot);
  if (group.relatedShots.some((item) => relatedShotIdentityKey(item) === key)) {
    return;
  }
  group.relatedShots.push(relatedShot);
}

function relatedShotIdentityKey(shot) {
  return [
    shot.sectionKey || "banner",
    shot.coverageKey || "",
    shot.bannerIndex ? `banner:${shot.bannerIndex}` : "",
    shot.tabIndex || shot.tabLabel || "",
    shot.interactionState || "default",
    shot.hoverItemKey || shot.hoverIndex || "",
    shot.pageIndex || "",
    shot.stateIndex || "",
    shot.logicalSignature || shot.stateLabel || shot.label || shot.file || shot.imageUrl || ""
  ].join("|");
}

function sortedRelatedShots(relatedShots) {
  return [...relatedShots].sort((a, b) =>
    relatedSectionSort(a.sectionKey) - relatedSectionSort(b.sectionKey) ||
    String(a.tabLabel || "").localeCompare(String(b.tabLabel || ""), "zh-CN") ||
    relatedInteractionSort(a) - relatedInteractionSort(b) ||
    Number(a.pageIndex || 0) - Number(b.pageIndex || 0) ||
    Number(a.hoverIndex || 0) - Number(b.hoverIndex || 0) ||
    Number(a.stateIndex || 0) - Number(b.stateIndex || 0) ||
    Number(a.bannerIndex || 0) - Number(b.bannerIndex || 0) ||
    String(a.label || "").localeCompare(String(b.label || ""), "zh-CN")
  );
}

function relatedInteractionSort(shot) {
  return shot?.interactionState === "hover" ? 1 : 0;
}

function relatedSectionSort(sectionKey) {
  const index = relatedSectionOrder.indexOf(sectionKey || "banner");
  return index === -1 ? 1000 : index;
}

function galleryCardKey(card) {
  const snapshot = card.snapshot || {};
  if (card.homeGroup) {
    return [
      "home",
      homeGroupKey(snapshot),
      snapshot.id || "",
      snapshot.file || "",
      snapshot.capturedAt || ""
    ].join("|");
  }
  return [
    "shot",
    snapshot.id || "",
    snapshot.file || "",
    snapshot.imageUrl || "",
    snapshot.capturedAt || ""
  ].join("|");
}

function renderShotCard(card) {
  const snapshot = card.snapshot;
  const displayUrl = card.homeGroup ? homeDisplayUrl() : canonicalDisplayUrlForSnapshot(snapshot);
  const cardKey = galleryCardKey(card);
  const item = document.createElement("article");
  const hasRelatedWarning = relatedWarnings(card.relatedValidation).length > 0;
  item.className = [
    "shot",
    card.relatedShots.length ? "has-related-shots" : "",
    hasRelatedWarning ? "has-related-warning" : ""
  ].filter(Boolean).join(" ");
  item.dataset.galleryCardKey = cardKey;
  item.dataset.snapshotId = snapshot.id || "";
  item.dataset.devicePresetId = snapshot.devicePresetId || "";
  item.dataset.viewportHeight = String(Number(snapshot.scrollInfo?.viewportHeight || 0) || "");
  item.innerHTML = `
    <div class="shot-hero">
      <a class="shot-main-image" href="${snapshot.imageUrl}" target="_blank" rel="noreferrer" data-snapshot-id="${escapeHtml(snapshot.id || "")}" data-snapshot-file="${escapeHtml(snapshot.file || "")}">
        <img src="${snapshot.imageUrl}" alt="${escapeHtml(displayUrl)} ${formatDate(snapshot.capturedAt)}" loading="lazy">
      </a>
      ${renderSnapshotDeleteButton(snapshot)}
    </div>
    <div class="shot-info">
      <p class="shot-title" title="${escapeHtml(snapshot.title || displayUrl)}">${escapeHtml(displayUrl)}</p>
      <p class="shot-meta">
        <span class="pill">${formatDate(snapshot.capturedAt)}</span>
        <span class="pill device">${escapeHtml(deviceNameForSnapshot(snapshot))}</span>
        <span class="pill">${snapshot.width}×${snapshot.height}</span>
        ${snapshot.truncated ? "<span class=\"pill warn\">已截断</span>" : ""}
        ${isLowConfidenceCapture(snapshot.captureConfidence) ? `<span class="pill low-confidence" title="${escapeHtml(captureConfidenceTitle(snapshot.captureConfidence))}">低可信</span>` : ""}
      </p>
    </div>
    ${renderRelatedShots(card.relatedShots, card.relatedValidation, cardKey)}
  `;
  return item;
}

function renderSnapshotDeleteButton(snapshot) {
  if (!state?.permissions?.canDeleteSnapshots) {
    return "";
  }

  const snapshotId = String(snapshot?.id || "").trim();
  const pending = pendingSnapshotDeletes.has(snapshotId);
  const captureRunning = Boolean(state?.capture?.running);
  const disabled = pending || captureRunning;
  const label = pending ? "删除中..." : "删除本次截图";
  const title = captureRunning
    ? "截图运行中，暂时不能删除。"
    : "删除这次截图的主图、相关小图，并重算变更汇总。";

  return `
    <button
      class="shot-delete-button${pending ? " is-pending" : ""}"
      type="button"
      data-action="delete-snapshot"
      data-snapshot-id="${escapeHtml(snapshotId)}"
      title="${escapeHtml(title)}"
      ${disabled ? "disabled" : ""}
    >
      ${escapeHtml(label)}
    </button>
  `;
}

function renderRelatedShots(relatedShots, validation = null, cardKey = "") {
  const warnings = relatedWarnings(validation);
  const keyAttribute = cardKey ? ` data-gallery-card-key="${escapeHtml(cardKey)}"` : "";
  if (!relatedShots.length && !warnings.length) {
    return `<div class="shot-related shot-related-empty"${keyAttribute} aria-hidden="true"></div>`;
  }
  const groups = groupRelatedShots(relatedShots);
  const warningTitle = warnings.map((warning) =>
    `${warning.sectionLabel || warning.sectionKey || "更多截图"}：${warning.message || "校验警告"}`
  ).join("\n");
  const warningItems = warningPayload(warnings);

  return `
    <div class="shot-related"${keyAttribute}>
      <p class="related-kicker">
        更多截图
        ${warnings.length ? `<button type="button" class="related-warning" title="${escapeHtml(warningTitle)}" data-warning-title="更多截图校验警告" data-warning-items="${escapeHtml(warningItems)}">校验警告</button>` : ""}
      </p>
      ${groups.map((group) => renderRelatedSection(group)).join("")}
    </div>
  `;
}

function relatedWarningScope(warning) {
  return [
    warning.sectionLabel || warning.sectionKey || "更多截图",
    warning.stateLabel
  ].filter(Boolean).join(" / ");
}

function relatedWarningMessage(warning) {
  const message = warning.message || "校验警告";
  if (/looked duplicated and was not saved\.$/.test(message)) {
    return "判定为重复截图，已跳过保存。";
  }
  return message;
}

function renderRelatedSection(group) {
  if (groupHasTabbedPages(group)) {
    const tabGroups = groupRelatedShotsByTab(group.shots);
    const sectionClass = [
      "related-section",
      "related-section-tabbed",
      group.sectionKey === "product-showcase" ? "related-section-product-showcase" : "",
      group.sectionKey === "navigation" ? "related-section-navigation" : ""
    ].filter(Boolean).join(" ");
    return `
      <section class="${sectionClass}">
        <p class="related-title">${escapeHtml(group.title)}</p>
        <div class="related-tab-groups">
          ${tabGroups.map((tabGroup) => `
            <section class="related-tab-group">
              <p class="related-tab-title">${escapeHtml(tabGroup.title)}</p>
              ${renderTabbedRelatedShots(group.sectionKey, tabGroup.shots)}
            </section>
          `).join("")}
        </div>
      </section>
    `;
  }

  return `
    <section class="related-section">
      <p class="related-title">${escapeHtml(group.title)}</p>
      ${renderRelatedThumbGrid(group.shots)}
    </section>
  `;
}

function renderTabbedRelatedShots(sectionKey, shots) {
  if (sectionKey === "product-showcase") {
    return renderProductShowcaseTabShots(shots);
  }
  if (sectionKey === "navigation") {
    return renderNavigationTabShots(shots);
  }
  return renderRelatedThumbGrid(shots);
}

function renderNavigationTabShots(shots) {
  const primaryShots = shots.filter((shot) => navigationLevelForShot(shot) === "primary");
  const secondaryShots = shots.filter((shot) => navigationLevelForShot(shot) !== "primary");
  return `
    ${primaryShots.length ? `
      <div class="related-tab-subgroup">
        <p class="related-subtitle">一级分类</p>
        ${renderRelatedThumbGrid(primaryShots)}
      </div>
    ` : ""}
    ${secondaryShots.length ? `
      <div class="related-tab-subgroup">
        <p class="related-subtitle">二级分类</p>
        ${renderRelatedThumbGrid(secondaryShots)}
      </div>
    ` : ""}
  `;
}

function renderProductShowcaseTabShots(shots) {
  const defaultShots = shots.filter((shot) => shot.interactionState !== "hover");
  const hoverShots = shots.filter((shot) => shot.interactionState === "hover");
  return `
    ${defaultShots.length ? `
      <div class="related-tab-subgroup">
        <p class="related-subtitle">默认</p>
        ${renderRelatedThumbGrid(defaultShots)}
      </div>
    ` : ""}
    ${hoverShots.length ? `
      <div class="related-tab-subgroup">
        <p class="related-subtitle">Hover</p>
        ${renderRelatedThumbGrid(hoverShots)}
      </div>
    ` : ""}
  `;
}

function groupHasTabbedPages(group) {
  return group.shots.some((shot) => shot.tabLabel && (relatedShotPageIndex(shot) || shot.interactionState === "hover"));
}

function renderRelatedThumbGrid(shots) {
  return `
    <div class="related-grid">
      ${shots.map((shot) => `
        <a
          class="related-thumb ${isLowConfidenceCapture(shot.captureConfidence) ? "related-thumb-low-confidence" : ""}"
          href="${shot.imageUrl}"
          target="_blank"
          rel="noreferrer"
          title="${escapeHtml(relatedShotTitle(shot))}"
          data-shot-file="${escapeHtml(shot.file || "")}"
          data-preview-width="${escapeHtml(String(shot.width || ""))}"
          data-preview-height="${escapeHtml(String(shot.height || ""))}"
          data-preview-viewport-height="${escapeHtml(String(shot.scrollInfo?.viewportHeight || ""))}"
          data-section-key="${escapeHtml(shot.sectionKey || "")}"
          data-navigation-level="${escapeHtml(shot.navigationLevel || "")}"
        >
          <img src="${shot.imageUrl}" alt="${escapeHtml(relatedShotDisplayLabel(shot))}" loading="lazy">
          ${isLowConfidenceCapture(shot.captureConfidence) ? `<span class="related-thumb-flag" title="${escapeHtml(captureConfidenceTitle(shot.captureConfidence))}">低可信</span>` : ""}
          <span>${escapeHtml(relatedThumbLabel(shot))}</span>
        </a>
      `).join("")}
    </div>
  `;
}

function groupRelatedShotsByTab(shots) {
  const groups = new Map();
  for (const shot of shots) {
    const key = `${shot.tabIndex || ""}|${shot.tabLabel || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        title: shot.tabLabel || "未命名 Tab",
        tabIndex: Number(shot.tabIndex || 0),
        shots: []
      });
    }
    groups.get(key).shots.push(shot);
  }
  return [...groups.values()].sort((a, b) =>
    Number(a.tabIndex || 0) - Number(b.tabIndex || 0) ||
    String(a.title).localeCompare(String(b.title), "zh-CN")
  );
}

function relatedThumbLabel(shot) {
  if (shot.sectionKey === "navigation") {
    return shot.hoverItemLabel || relatedShotDisplayLabel(shot);
  }
  if (shot.interactionState === "hover") {
    return `Hover ${shot.hoverItemLabel || relatedShotDisplayLabel(shot)}`;
  }
  const pageIndex = relatedShotPageIndex(shot);
  if (shot.tabLabel && pageIndex) {
    return `第 ${pageIndex} 张`;
  }
  return relatedShotDisplayLabel(shot);
}

function navigationLevelForShot(shot) {
  return shot?.navigationLevel || shot?.sectionState?.navigationLevel || "";
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
      if (sectionKey === "navigation") {
        groups.get(sectionKey).title = relatedSectionTitles.navigation;
      }
    }
    groups.get(sectionKey).shots.push(shot);
  }
  return [...groups.values()].sort((a, b) => relatedSectionSort(a.sectionKey) - relatedSectionSort(b.sectionKey));
}

function relatedWarnings(validation) {
  return Array.isArray(validation?.warnings) ? validation.warnings : [];
}

function isLowConfidenceCapture(captureConfidence) {
  return captureConfidence?.baselineEligible === false;
}

function captureConfidenceTitle(captureConfidence) {
  const reasons = Array.isArray(captureConfidence?.reasons)
    ? captureConfidence.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
    : [];
  return reasons.length ? reasons.join("\n") : "This capture is marked low confidence.";
}

function relatedShotTitle(shot) {
  const pageIndex = relatedShotPageIndex(shot);
  if (shot.sectionKey === "navigation") {
    const level = navigationLevelForShot(shot) === "primary" ? "一级分类" : "二级分类";
    return [
      shot.sectionLabel,
      shot.tabLabel,
      level,
      shot.hoverItemLabel || relatedShotDisplayLabel(shot),
      shot.visualAudit?.status && shot.visualAudit.status !== "ok" ? shot.visualAudit.message : ""
    ].filter(Boolean).join(" · ");
  }
  if (shot.interactionState === "hover") {
    return [
      shot.sectionLabel,
      shot.tabLabel,
      `Hover ${shot.hoverItemLabel || relatedShotDisplayLabel(shot)}`,
      shot.visualAudit?.status && shot.visualAudit.status !== "ok" ? shot.visualAudit.message : ""
    ].filter(Boolean).join(" / ");
  }
  const detailLabel = shot.tabLabel && pageIndex
    ? `第 ${pageIndex} 张`
    : relatedShotDisplayLabel(shot);
  return [
    shot.sectionLabel,
    shot.tabLabel,
    detailLabel,
    shot.visualAudit?.status && shot.visualAudit.status !== "ok" ? shot.visualAudit.message : ""
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
    captureConfidence: snapshot.captureConfidence || null,
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
  const displayLabel = relatedShotDisplayLabel(shot, bannerIndex);
  return {
    kind: shot.kind || "banner",
    sectionKey,
    sectionLabel: shot.sectionLabel || (sectionKey === "banner" ? "Banner" : ""),
    sectionTitle: shot.sectionTitle || relatedSectionTitles[sectionKey] || "",
    label: displayLabel,
    file: shot.file || "",
    imageUrl: shot.imageUrl,
    bytes: shot.bytes || null,
    width: shot.width || null,
    height: shot.height || null,
    stateIndex: shot.stateIndex || bannerIndex || null,
    stateCount: shot.stateCount || shot.bannerCount || null,
    stateLabel: validRelatedLabel(shot.stateLabel) ? String(shot.stateLabel).trim() : displayLabel,
    tabLabel: shot.tabLabel || null,
    tabIndex: shot.tabIndex || null,
    pageIndex: shot.pageIndex || null,
    interactionState: shot.interactionState || shot.sectionState?.interactionState || "default",
    navigationLevel: shot.navigationLevel || shot.sectionState?.navigationLevel || null,
    topLevelLabel: shot.topLevelLabel || shot.sectionState?.topLevelLabel || null,
    topLevelIndex: shot.topLevelIndex || shot.sectionState?.topLevelIndex || null,
    hoverItemKey: shot.hoverItemKey || shot.sectionState?.hoverItemKey || null,
    hoverItemLabel: shot.hoverItemLabel || shot.sectionState?.hoverItemLabel || null,
    hoverItemRect: shot.hoverItemRect || shot.sectionState?.hoverItemRect || null,
    basePageIndex: shot.basePageIndex || shot.sectionState?.basePageIndex || null,
    hoverIndex: shot.hoverIndex || shot.sectionState?.hoverIndex || null,
    trackLabel: shot.trackLabel || shot.tabLabel || null,
    trackIndex: shot.trackIndex || shot.tabIndex || null,
    itemCount: shot.itemCount || null,
    visibleItemCount: shot.visibleItemCount || null,
    visibleItems: shot.visibleItems || null,
    itemRects: shot.itemRects || null,
    windowSignature: shot.windowSignature || null,
    logicalSignature: shot.logicalSignature || shot.bannerSignature || null,
    visualHash: shot.visualHash || null,
    visualAudit: shot.visualAudit || null,
    captureConfidence: shot.captureConfidence || null,
    clip: shot.clip || shot.bannerClip || null,
    isDefaultState: Boolean(shot.isDefaultState),
    coverageKey: shot.coverageKey || null,
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

function relatedShotDisplayLabel(shot, bannerIndex = Number(shot?.bannerIndex || 0) || null) {
  if (validRelatedLabel(shot?.stateLabel)) {
    return String(shot.stateLabel).trim();
  }
  if (validRelatedLabel(shot?.label)) {
    return String(shot.label).trim();
  }
  return bannerIndex ? `轮播 ${bannerIndex}` : "轮播";
}

function validRelatedLabel(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/undefined|null/i.test(text);
}

function relatedShotPageIndex(shot) {
  const pageIndex = Number(shot?.pageIndex || 0);
  return Number.isFinite(pageIndex) && pageIndex > 0 ? pageIndex : null;
}

function urlFilterOptions() {
  const configured = (state.platforms?.[activePlatform]?.targets || configTargets(state.config))
    .map(displayUrlForTarget);
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

function canonicalDisplayUrlForChange(change) {
  const location = change.location || {};
  return canonicalDisplayUrlForSnapshot({
    targetId: location.targetId,
    url: location.url,
    displayUrl: location.displayUrl || location.targetLabel || location.url
  });
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
  const target = configTargets(state.config).find((item) => item.id === id);
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
    return deviceInfoForPreset(snapshot.devicePresetId, snapshot.deviceName || snapshot.deviceLabel);
  }

  const viewportHeight = snapshot.scrollInfo?.viewportHeight;
  const bySize = (state?.devicePresets || []).find((preset) =>
    Number(snapshot.width) === preset.width && Number(viewportHeight) === preset.height
  );
  if (bySize) {
    return { id: bySize.id, name: bySize.name, group: bySize.mobile ? "mobile" : "pc" };
  }

  const group = snapshot.platform || inferSnapshotDeviceGroup(snapshot);
  return {
    id: `custom-${group}`,
    name: group === "mobile" ? "自定义设备（手机端）" : "自定义设备（PC端）",
    group
  };
}

function deviceInfoForChange(change) {
  const location = change.location || {};
  if (location.devicePresetId) {
    return deviceInfoForPreset(location.devicePresetId, location.deviceName);
  }

  const name = location.deviceName || "未知设备";
  return {
    id: location.deviceName || "unknown-device",
    name,
    group: location.platform === "mobile" ? "mobile" : "pc"
  };
}

function deviceInfoForPreset(devicePresetId, fallbackName) {
  const byId = (state?.devicePresets || []).find((preset) => preset.id === devicePresetId);
  return {
    id: devicePresetId,
    name: byId?.name || fallbackName || devicePresetId,
    group: byId?.mobile ? "mobile" : "pc"
  };
}

function uniqueDevicesFromSnapshots() {
  const devices = new Map();
  for (const snapshot of platformSnapshots()) {
    const device = deviceInfoForSnapshot(snapshot);
    devices.set(device.id, device);
  }
  return [...devices.values()].sort(compareDevices);
}

function uniqueDevicesFromChanges() {
  const devices = new Map();
  for (const change of platformChanges()) {
    const device = deviceInfoForChange(change);
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
