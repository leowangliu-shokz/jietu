import crypto from "node:crypto";
import { decodePng } from "./png.js";

export function hashBuffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

export function visualHashForBuffer(buffer) {
  try {
    const image = decodePng(buffer);
    const samples = [];
    for (let y = 0; y < 8; y += 1) {
      const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / 8));
      for (let x = 0; x < 8; x += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / 8));
        const offset = (sourceY * image.width + sourceX) * 4;
        const gray = Math.round(
          image.rgba[offset] * 0.299 +
          image.rgba[offset + 1] * 0.587 +
          image.rgba[offset + 2] * 0.114
        );
        samples.push(gray);
      }
    }
    const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    let bits = "";
    for (const value of samples) {
      bits += value >= average ? "1" : "0";
    }
    let hex = "";
    for (let index = 0; index < bits.length; index += 4) {
      hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return hashBuffer(buffer).slice(0, 16);
  }
}

export function visualAuditForBuffer(buffer, visualHash, similar = null) {
  const quality = imageQualityAuditForBuffer(buffer);
  const audit = {
    status: "ok",
    visualHash,
    sharpness: quality.sharpness,
    contrast: quality.contrast
  };
  const messages = [];

  if (similar && similar.distance <= 3) {
    audit.similarTo = similar.label;
    audit.distance = similar.distance;
    messages.push(`Visual signature is very close to ${similar.label}.`);
  }
  if (quality.status === "warning") {
    audit.qualityStatus = "warning";
    messages.push(quality.message);
  }

  if (messages.length) {
    audit.status = "warning";
    audit.message = messages.join(" ");
  }

  return audit;
}

export function imageQualityAuditForBuffer(buffer) {
  try {
    const image = decodePng(buffer);
    if (image.width < 3 || image.height < 3) {
      return {
        status: "warning",
        sharpness: 0,
        contrast: 0,
        message: "Image is too small for quality audit."
      };
    }

    const maxSamples = 60000;
    const step = Math.max(1, Math.ceil(Math.sqrt((image.width * image.height) / maxSamples)));
    let count = 0;
    let sum = 0;
    let sumSquares = 0;
    let edgeCount = 0;
    let edgeSum = 0;

    for (let y = 0; y < image.height; y += step) {
      for (let x = 0; x < image.width; x += step) {
        const gray = grayAt(image, x, y);
        count += 1;
        sum += gray;
        sumSquares += gray * gray;

        if (x + step < image.width) {
          edgeSum += Math.abs(gray - grayAt(image, x + step, y));
          edgeCount += 1;
        }
        if (y + step < image.height) {
          edgeSum += Math.abs(gray - grayAt(image, x, y + step));
          edgeCount += 1;
        }
      }
    }

    const mean = sum / Math.max(1, count);
    const variance = Math.max(0, (sumSquares / Math.max(1, count)) - mean * mean);
    const contrast = Math.sqrt(variance);
    const sharpness = edgeSum / Math.max(1, edgeCount);
    const roundedSharpness = roundMetric(sharpness);
    const roundedContrast = roundMetric(contrast);

    if (sharpness < 4 && contrast < 18) {
      return {
        status: "warning",
        sharpness: roundedSharpness,
        contrast: roundedContrast,
        message: "Image may be blurry or low detail."
      };
    }

    return {
      status: "ok",
      sharpness: roundedSharpness,
      contrast: roundedContrast
    };
  } catch (error) {
    return {
      status: "warning",
      sharpness: null,
      contrast: null,
      message: `Image quality audit failed: ${error.message}`
    };
  }
}

export function nearestVisualHash(hash, previous) {
  return previous
    .map((item) => ({ ...item, distance: visualHashDistance(hash, item.hash) }))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function grayAt(image, x, y) {
  const sourceX = Math.max(0, Math.min(image.width - 1, x));
  const sourceY = Math.max(0, Math.min(image.height - 1, y));
  const offset = (sourceY * image.width + sourceX) * 4;
  return (
    image.rgba[offset] * 0.299 +
    image.rgba[offset + 1] * 0.587 +
    image.rgba[offset + 2] * 0.114
  );
}

function roundMetric(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function visualHashDistance(a, b) {
  if (!a || !b || a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = Number.parseInt(a[index], 16);
    const right = Number.parseInt(b[index], 16);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return Number.POSITIVE_INFINITY;
    }
    distance += bitCount(left ^ right);
  }
  return distance;
}

function bitCount(value) {
  let count = 0;
  let number = value;
  while (number) {
    count += number & 1;
    number >>= 1;
  }
  return count;
}
