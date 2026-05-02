const elements = {
  refresh: document.querySelector("#refresh"),
  shotCount: document.querySelector("#shotCount"),
  scheduleState: document.querySelector("#scheduleState"),
  browserState: document.querySelector("#browserState"),
  captureState: document.querySelector("#captureState"),
  nextRun: document.querySelector("#nextRun"),
  deviceFilter: document.querySelector("#deviceFilter"),
  deviceFilterButton: document.querySelector("#deviceFilterButton"),
  deviceFilterLabel: document.querySelector("#deviceFilterLabel"),
  deviceFilterMenu: document.querySelector("#deviceFilterMenu"),
  runSourceFilter: document.querySelector("#runSourceFilter"),
  urlFilter: document.querySelector("#urlFilter"),
  gallery: document.querySelector("#gallery"),
  empty: document.querySelector("#empty")
};

let state = null;
const selectedDeviceFilters = {
  categories: new Set(),
  devices: new Set()
};

await refreshState();
setInterval(refreshState, 10000);

elements.refresh.addEventListener("click", refreshState);
elements.urlFilter.addEventListener("change", renderGallery);
elements.runSourceFilter.addEventListener("change", renderGallery);
elements.deviceFilterButton.addEventListener("click", toggleDeviceFilterMenu);
elements.deviceFilterMenu.addEventListener("change", handleDeviceFilterChange);
elements.deviceFilterMenu.addEventListener("click", handleDeviceFilterClick);
document.addEventListener("click", closeDeviceFilterOnOutsideClick);
document.addEventListener("keydown", closeDeviceFilterOnEscape);

async function refreshState() {
  const response = await fetch("/api/state");
  state = await response.json();
  render();
}

function render() {
  elements.shotCount.textContent = state.snapshots.length;
  elements.captureState.textContent = state.capture.running ? "截图中" : "空闲";
  elements.browserState.textContent = state.browser.ok ? browserName(state.browser.path) : "未找到";
  elements.scheduleState.textContent = "整点（所有设备）";
  elements.nextRun.textContent = state.nextRunAt
    ? `下次整点自动截图：${formatDate(state.nextRunAt)}`
    : "下次整点自动截图：计算中";
  renderFilterOptions();
  renderDeviceFilterOptions();
  renderGallery();
}

function renderFilterOptions() {
  const current = elements.urlFilter.value;
  const urls = [...new Set(state.snapshots.map((snapshot) => snapshot.url))];
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
  const availableCategories = new Set(groups.map((group) => group.id));
  selectedDeviceFilters.categories = new Set(
    [...selectedDeviceFilters.categories].filter((id) => availableCategories.has(id))
  );
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
    categoryInput.checked = selectedDeviceFilters.categories.has(group.id);

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
  selectedDeviceFilters.categories.clear();
  selectedDeviceFilters.devices.clear();
  renderDeviceFilterOptions();
  renderGallery();
}

function handleDeviceFilterChange(event) {
  const input = event.target.closest("input[type='checkbox']");
  if (!input) {
    return;
  }

  const selected = input.dataset.filterType === "category"
    ? selectedDeviceFilters.categories
    : selectedDeviceFilters.devices;
  if (input.checked) {
    selected.add(input.value);
  } else {
    selected.delete(input.value);
  }

  renderDeviceFilterLabel(uniqueDevicesFromSnapshots());
  renderGallery();
}

function renderDeviceFilterLabel(devices) {
  const groupLabels = new Map(deviceFilterGroups(devices).map((group) => [group.id, group.name]));
  const deviceLabels = new Map(devices.map((device) => [device.id, device.name]));
  const labels = [
    ...[...selectedDeviceFilters.categories].map((id) => groupLabels.get(id)).filter(Boolean),
    ...[...selectedDeviceFilters.devices].map((id) => deviceLabels.get(id)).filter(Boolean)
  ];

  const label = labels.length === 0
    ? "全部截图设备"
    : labels.length === 1
      ? labels[0]
      : `已选 ${labels.length} 项`;
  elements.deviceFilterLabel.textContent = label;
  elements.deviceFilterButton.title = labels.join("、");
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
  if (selectedDeviceFilters.categories.size === 0 && selectedDeviceFilters.devices.size === 0) {
    return true;
  }

  const device = deviceInfoForSnapshot(snapshot);
  return selectedDeviceFilters.devices.has(device.id) || selectedDeviceFilters.categories.has(device.group);
}

function renderGallery() {
  const selectedUrl = elements.urlFilter.value;
  const selectedRunSource = elements.runSourceFilter.value;
  const snapshots = state.snapshots.filter((snapshot) => {
    const matchesUrl = selectedUrl ? snapshot.url === selectedUrl : true;
    const matchesRunSource = selectedRunSource
      ? runSourceForSnapshot(snapshot) === selectedRunSource
      : true;
    const matchesDevice = matchesDeviceFilters(snapshot);
    return matchesUrl && matchesRunSource && matchesDevice;
  });

  elements.gallery.innerHTML = "";
  elements.empty.classList.toggle("visible", snapshots.length === 0);

  for (const snapshot of snapshots) {
    const item = document.createElement("article");
    item.className = "shot";
    item.innerHTML = `
      <a href="${snapshot.imageUrl}" target="_blank" rel="noreferrer">
        <img src="${snapshot.imageUrl}" alt="${escapeHtml(snapshot.url)} 在 ${formatDate(snapshot.capturedAt)} 的截图" loading="lazy">
      </a>
      <div class="shot-body">
        <p class="shot-title" title="${escapeHtml(snapshot.title || snapshot.url)}">${escapeHtml(snapshot.title || snapshot.url)}</p>
        <p class="shot-meta">
          <span class="pill">${formatDate(snapshot.capturedAt)}</span>
          <span class="pill run ${runSourceForSnapshot(snapshot)}">${escapeHtml(runLabelForSnapshot(snapshot))}</span>
          <span class="pill device">${escapeHtml(deviceNameForSnapshot(snapshot))}</span>
          <span class="pill">${snapshot.width}×${snapshot.height}</span>
          ${snapshot.truncated ? "<span class=\"pill warn\">已截断</span>" : ""}
        </p>
      </div>
    `;
    elements.gallery.append(item);
  }
}

function runSourceForSnapshot(snapshot) {
  return snapshot.runSource === "auto" ? "auto" : "manual";
}

function runLabelForSnapshot(snapshot) {
  if (snapshot.runLabel) {
    return snapshot.runLabel;
  }
  return runSourceForSnapshot(snapshot) === "auto" ? "自动跑（整点）" : "手动跑";
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
