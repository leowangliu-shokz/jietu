export const defaultDevicePresetId = "pc-hd";

export const devicePresets = [
  { id: "pc-1024", group: "PC", name: "PC", width: 1024, height: 960, deviceScaleFactor: 1, mobile: false, touch: false },
  { id: "pc-laptop", group: "PC", name: "PC 笔记本", width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
  { id: "pc-hd", group: "PC", name: "PC 高清屏", width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
  { id: "macbook-air-13", group: "Mac", name: "MacBook Air 13\"", width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
  { id: "macbook-pro-14", group: "Mac", name: "MacBook Pro 14\"", width: 1512, height: 982, deviceScaleFactor: 1, mobile: false, touch: false },
  { id: "macbook-pro-16", group: "Mac", name: "MacBook Pro 16\"", width: 1728, height: 1117, deviceScaleFactor: 1, mobile: false, touch: false },
  { id: "ipad-10-9", group: "平板", name: "iPad 10.9\"", width: 820, height: 1180, deviceScaleFactor: 1, mobile: true, touch: true },
  { id: "iphone-se", group: "手机", name: "iPhone SE", width: 375, height: 667, deviceScaleFactor: 1, mobile: true, touch: true },
  { id: "iphone-15", group: "手机", name: "iPhone 15", width: 393, height: 852, deviceScaleFactor: 1, mobile: true, touch: true },
  { id: "iphone-15-pro-max", group: "手机", name: "iPhone 15 Pro Max", width: 430, height: 932, deviceScaleFactor: 1, mobile: true, touch: true },
  { id: "xiaomi-13-ultra", group: "手机", name: "Xiaomi 13 Ultra", width: 393, height: 873, deviceScaleFactor: 1, mobile: true, touch: true },
  { id: "samsung-galaxy-s24", group: "手机", name: "Samsung Galaxy S24", width: 384, height: 854, deviceScaleFactor: 1, mobile: true, touch: true }
];

export function findDevicePreset(id) {
  return devicePresets.find((preset) => preset.id === id) || null;
}

export function findDevicePresetByViewport(viewport = {}) {
  return devicePresets.find((preset) =>
    Number(viewport.width) === preset.width && Number(viewport.height) === preset.height
  ) || null;
}

export function getDefaultDevicePreset() {
  return findDevicePreset(defaultDevicePresetId) || devicePresets[0];
}

export function toPublicDevicePreset(preset) {
  return {
    id: preset.id,
    group: preset.group,
    name: preset.name,
    width: preset.width,
    height: preset.height,
    label: `${preset.name}（${preset.width}×${preset.height}）`,
    mobile: preset.mobile
  };
}
