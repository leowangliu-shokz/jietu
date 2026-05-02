const elements = {
  refresh: document.querySelector("#refresh"),
  shotCount: document.querySelector("#shotCount"),
  scheduleState: document.querySelector("#scheduleState"),
  browserState: document.querySelector("#browserState"),
  captureState: document.querySelector("#captureState"),
  nextRun: document.querySelector("#nextRun"),
  deviceFilter: document.querySelector("#deviceFilter"),
  runSourceFilter: document.querySelector("#runSourceFilter"),
  urlFilter: document.querySelector("#urlFilter"),
  gallery: document.querySelector("#gallery"),
  empty: document.querySelector("#empty")
};

let state = null;

await refreshState();
setInterval(refreshState, 10000);

elements.refresh.addEventListener("click", refreshState);
elements.urlFilter.addEventListener("change", renderGallery);
elements.runSourceFilter.addEventListener("change", renderGallery);
elements.deviceFilter.addEventListener("change", renderGallery);

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
  const current = elements.deviceFilter.value;
  const devices = uniqueDevicesFromSnapshots();
  elements.deviceFilter.innerHTML = "<option value=\"\">全部截图设备</option>";

  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.name;
    elements.deviceFilter.append(option);
  }

  elements.deviceFilter.value = devices.some((device) => device.id === current) ? current : "";
}

function renderGallery() {
  const selectedUrl = elements.urlFilter.value;
  const selectedRunSource = elements.runSourceFilter.value;
  const selectedDevice = elements.deviceFilter.value;
  const snapshots = state.snapshots.filter((snapshot) => {
    const matchesUrl = selectedUrl ? snapshot.url === selectedUrl : true;
    const matchesRunSource = selectedRunSource
      ? runSourceForSnapshot(snapshot) === selectedRunSource
      : true;
    const matchesDevice = selectedDevice
      ? deviceIdForSnapshot(snapshot) === selectedDevice
      : true;
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
      name: byId?.name || snapshot.deviceName || snapshot.devicePresetId
    };
  }

  const viewportHeight = snapshot.scrollInfo?.viewportHeight;
  const bySize = (state?.devicePresets || []).find((preset) =>
    Number(snapshot.width) === preset.width && Number(viewportHeight) === preset.height
  );
  if (bySize) {
    return { id: bySize.id, name: bySize.name };
  }

  return { id: "custom", name: "自定义设备" };
}

function uniqueDevicesFromSnapshots() {
  const devices = new Map();
  for (const snapshot of state.snapshots) {
    const device = deviceInfoForSnapshot(snapshot);
    devices.set(device.id, device);
  }
  return [...devices.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
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
