import zlib from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = createCrcTable();

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Unsupported PNG signature.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}.`);
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const rgba = new Uint8Array(width * height * 4);
  let sourceOffset = 0;
  let destOffset = 0;
  let previous = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const current = new Uint8Array(rowBytes);

    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      current[x] = unfilter(raw, filter, left, up, upLeft);
    }

    sourceOffset += rowBytes;

    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      rgba[destOffset] = current[source];
      rgba[destOffset + 1] = current[source + 1];
      rgba[destOffset + 2] = current[source + 2];
      rgba[destOffset + 3] = colorType === 6 ? current[source + 3] : 255;
      destOffset += 4;
    }

    previous = current;
  }

  return { width, height, rgba };
}

export function encodePng(width, height, rgba) {
  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe(height * (rowBytes + 1));
  let sourceOffset = 0;
  let targetOffset = 0;

  for (let y = 0; y < height; y += 1) {
    raw[targetOffset] = 0;
    targetOffset += 1;
    raw.set(rgba.subarray(sourceOffset, sourceOffset + rowBytes), targetOffset);
    sourceOffset += rowBytes;
    targetOffset += rowBytes;
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", createIhdr(width, height)),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function unfilter(raw, filter, left, up, upLeft) {
  if (filter === 0) {
    return raw;
  }
  if (filter === 1) {
    return (raw + left) & 255;
  }
  if (filter === 2) {
    return (raw + up) & 255;
  }
  if (filter === 3) {
    return (raw + Math.floor((left + up) / 2)) & 255;
  }
  if (filter === 4) {
    return (raw + paeth(left, up, upLeft)) & 255;
  }
  throw new Error(`Unsupported PNG filter: ${filter}.`);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);

  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
    return left;
  }
  if (distanceUp <= distanceUpLeft) {
    return up;
  }
  return upLeft;
}

function createIhdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
