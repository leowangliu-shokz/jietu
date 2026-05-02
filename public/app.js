const elements = {
  captureNow: document.querySelector("#captureNow"),
  refresh: document.querySelector("#refresh"),
  settings: document.querySelector("#settings"),
  urls: document.querySelector("#urls"),
  wait: document.querySelector("#wait"),
  devicePreset: document.querySelector("#devicePreset"),
  fullPage: document.querySelector("#fullPage"),
  message: document.querySelector("#message"),
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
elements.captureNow.addEventListener("click", async () => {
  setBusy(true, "正在截图，页面较大时需要几十秒。");
  try {
    const response = await fetch("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "截图失败");
    }
    const failed = payload.results.filter((result) => !result.ok);
    showMessage(failed.length ? `完成，但 ${failed.length} 个 URL 失败。` : "截图已存档。");
    await refreshState();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    setBusy(false);
  }
});

elements.settings.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true, "正在保存设置。");
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readSettings())
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "保存失败");
    }
    state = payload;
    applyStateToForm();
    render();
    showMessage("设置已保存。");
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    setBusy(false);
  }
});

async function refreshState() {
  const response = await fetch("/api/state");
  state = await response.json();
  applyStateToForm();
  render();
}

function applyStateToForm() {
  if (!state?.config) {
    return;
  }
  renderDeviceOptions();
  if (!elements.urls.matches(":focus")) {
    elements.urls.value = state.config.urls.join("\n");
  }
  elements.wait.value = state.config.waitAfterLoadMs;
  elements.devicePreset.value = state.config.devicePresetId;
  elements.fullPage.checked = state.config.fullPage;
}

function renderDeviceOptions() {
  const presets = state.devicePresets || [];
  const currentValue = elements.devicePreset.value || state.config.devicePresetId;
  elements.devicePreset.innerHTML = "";
  const groups = new Map();

  for (const preset of presets) {
    if (!groups.has(preset.group)) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = preset.group;
      groups.set(preset.group, optgroup);
      elements.devicePreset.append(optgroup);
    }

    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    groups.get(preset.group).append(option);
  }

  elements.devicePreset.value = presets.some((preset) => preset.id === currentValue)
    ? currentValue
    : state.config.devicePresetId;
}

function readSettings() {
  return {
    urls: elements.urls.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    intervalMinutes: state.config.intervalMinutes || 0,
    waitAfterLoadMs: Number(elements.wait.value || 2500),
    devicePresetId: elements.devicePreset.value,
    fullPage: elements.fullPage.checked
  };
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

function setBusy(isBusy, message = "") {
  elements.captureNow.disabled = isBusy;
  elements.refresh.disabled = isBusy;
  elements.settings.querySelector("button[type='submit']").disabled = isBusy;
  if (message) {
    showMessage(message);
  }
}

function showMessage(message, isError = false) {
  elements.message.textContent = message;
  elements.message.classList.toggle("error", isError);
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
