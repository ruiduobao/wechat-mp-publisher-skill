import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Jimp, JimpMime, type JimpInstance } from "jimp";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";

export interface WechatUploadAsset {
  buffer: Buffer;
  filename: string;
  contentType: string;
  fileExt: string;
  fileSize: number;
}

export interface PreparedWechatUploadAsset {
  buffer: Buffer;
  filename: string;
  contentType: string;
  wasProcessed: boolean;
  processingNotes: string[];
}

export const WECHAT_BODY_IMAGE_MAX_SIZE = 1024 * 1024; // 1MB
export const WECHAT_BODY_IMAGE_UNSUPPORTED_FORMATS = new Set([
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".svg",
  ".ico",
]);

const BODY_UPLOAD_ALLOWED_MIME_TYPES = new Set<string>([
  JimpMime.jpeg,
  JimpMime.png,
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/x-ms-bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

const JPEG_QUALITY_STEPS = [82, 74, 66, 58, 50, 42, 34];
const MAX_WIDTH_STEPS = [2560, 2048, 1600, 1280, 1024, 800, 640, 480];

/**
 * Detect actual image format from buffer magic bytes.
 * Returns corrected { contentType, fileExt } or null if unknown.
 */
export function detectImageFormatFromBuffer(buffer: Buffer): { contentType: string; fileExt: string } | null {
  if (buffer.length < 12) return null;

  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return { contentType: "image/webp", fileExt: ".webp" };
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { contentType: "image/png", fileExt: ".png" };
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: "image/jpeg", fileExt: ".jpg" };
  }
  // GIF: GIF8
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return { contentType: "image/gif", fileExt: ".gif" };
  }
  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { contentType: "image/bmp", fileExt: ".bmp" };
  }
  return null;
}

let webpDecoderReady: Promise<void> | undefined;

type JimpImage = JimpInstance;

function normalizeMimeType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function extFromMimeType(contentType: string): string {
  return MIME_TO_EXT[normalizeMimeType(contentType)] || "";
}

function ensureFileExt(asset: WechatUploadAsset): string {
  return asset.fileExt || extFromMimeType(asset.contentType);
}

function basenameWithoutExt(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  return base || "image";
}

function renameWithExt(filename: string, ext: string): string {
  return `${basenameWithoutExt(filename)}${ext}`;
}

export function needsWechatBodyImageProcessing(asset: WechatUploadAsset): boolean {
  if (asset.fileSize > WECHAT_BODY_IMAGE_MAX_SIZE) {
    return true;
  }

  const normalizedMimeType = normalizeMimeType(asset.contentType);
  if (BODY_UPLOAD_ALLOWED_MIME_TYPES.has(normalizedMimeType)) {
    return false;
  }

  const fileExt = ensureFileExt(asset);
  return WECHAT_BODY_IMAGE_UNSUPPORTED_FORMATS.has(fileExt) || !fileExt;
}

async function ensureWebpDecoder(): Promise<void> {
  if (!webpDecoderReady) {
    webpDecoderReady = (async () => {
      const wasmPath = createRequire(import.meta.url).resolve("@jsquash/webp/codec/dec/webp_dec.wasm");
      const wasmModule = await WebAssembly.compile(await fs.readFile(wasmPath));
      await initWebpDecode(wasmModule as any);
    })();
  }

  await webpDecoderReady;
}

async function decodeImageViaPythonPillow(buffer: Buffer): Promise<JimpImage | null> {
  const pyScript = [
    "import io, struct, sys",
    "from PIL import Image, ImageFile",
    "ImageFile.LOAD_TRUNCATED_IMAGES = True",
    "data = sys.stdin.buffer.read()",
    "im = Image.open(io.BytesIO(data))",
    "im.load()",
    "rgba = im.convert('RGBA')",
    "sys.stdout.buffer.write(struct.pack('>II', rgba.width, rgba.height))",
    "sys.stdout.buffer.write(rgba.tobytes())",
  ].join("\n");

  for (const bin of ["python", "python3"]) {
    const decoded = await new Promise<JimpImage | null>((resolve) => {
      let settled = false;
      const finish = (val: JimpImage | null) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };

      const child = spawn(bin, ["-I", "-c", pyScript], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let totalLen = 0;
      const MAX_BYTES = 128 * 1024 * 1024;
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(null);
      }, 20_000);

      child.stdout.on("data", (chunk: Buffer) => {
        totalLen += chunk.length;
        if (totalLen <= MAX_BYTES) chunks.push(chunk);
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || totalLen < 8 || totalLen > MAX_BYTES) {
          finish(null);
          return;
        }
        const out = Buffer.concat(chunks, totalLen);
        const width = out.readUInt32BE(0);
        const height = out.readUInt32BE(4);
        const expected = 8 + width * height * 4;
        if (width <= 0 || height <= 0 || out.length !== expected) {
          finish(null);
          return;
        }
        finish(new Jimp({
          data: out.subarray(8),
          width,
          height,
        }));
      });

      child.stdin.on("error", () => {});
      child.stdin.end(buffer);
    });

    if (decoded) return decoded;
  }

  return null;
}

async function loadImageForProcessing(asset: WechatUploadAsset): Promise<JimpImage> {
  const fileExt = ensureFileExt(asset);
  const normalizedMimeType = normalizeMimeType(asset.contentType);

  if (fileExt === ".webp" || normalizedMimeType === "image/webp") {
    await ensureWebpDecoder();
    const arrayBuffer = asset.buffer.buffer.slice(asset.buffer.byteOffset, asset.buffer.byteOffset + asset.buffer.byteLength) as ArrayBuffer;
    const decoded = await decodeWebp(arrayBuffer);
    const jimpImage: JimpImage = new Jimp({
      data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height,
    });
    return jimpImage;
  }

  if (fileExt === ".svg" || fileExt === ".ico") {
    throw new Error(`Cannot convert ${fileExt} image for WeChat body upload; provide a PNG or JPG instead.`);
  }

  try {
    const readImage = await Jimp.read(asset.buffer);
    return readImage as unknown as JimpImage;
  } catch (jimpError) {
    const fallback = await decodeImageViaPythonPillow(asset.buffer);
    if (fallback) {
      return fallback;
    }
    throw jimpError;
  }
}

function imageHasTransparency(image: JimpImage): boolean {
  const { data } = image.bitmap;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      return true;
    }
  }
  return false;
}

function buildCandidateWidths(width: number): number[] {
  const candidates = new Set<number>([width]);

  for (const maxWidth of MAX_WIDTH_STEPS) {
    if (width > maxWidth) {
      candidates.add(maxWidth);
    }
  }

  return [...candidates].sort((a, b) => b - a);
}

function resizeToWidth(image: JimpImage, width: number): JimpImage {
  const cloned = image.clone();
  if (width < image.bitmap.width) {
    cloned.resize({ w: width });
  }
  return cloned;
}

function flattenOnWhite(image: JimpImage): JimpImage {
  const flattened = new Jimp({
    width: image.bitmap.width,
    height: image.bitmap.height,
    color: 0xffffffff,
  });
  flattened.composite(image, 0, 0);
  return flattened;
}

async function encodePng(image: JimpImage): Promise<Buffer> {
  return image.getBuffer(JimpMime.png);
}

async function encodeJpeg(image: JimpImage, quality: number): Promise<Buffer> {
  const jpegSource = imageHasTransparency(image) ? flattenOnWhite(image) : image;
  return jpegSource.getBuffer(JimpMime.jpeg, { quality });
}

function buildProcessingNotes(asset: WechatUploadAsset): string[] {
  const notes: string[] = [];
  const fileExt = ensureFileExt(asset);

  if (fileExt && WECHAT_BODY_IMAGE_UNSUPPORTED_FORMATS.has(fileExt)) {
    notes.push(`converted unsupported ${fileExt} source`);
  }

  if (asset.fileSize > WECHAT_BODY_IMAGE_MAX_SIZE) {
    notes.push(`compressed ${(asset.fileSize / 1024 / 1024).toFixed(2)}MB source below 1MB`);
  }

  if (notes.length === 0) {
    notes.push("re-encoded for WeChat body upload");
  }

  return notes;
}

export async function prepareWechatBodyImageUpload(
  asset: WechatUploadAsset,
): Promise<PreparedWechatUploadAsset> {
  if (!needsWechatBodyImageProcessing(asset)) {
    return {
      buffer: asset.buffer,
      filename: asset.filename,
      contentType: asset.contentType,
      wasProcessed: false,
      processingNotes: [],
    };
  }

  const image = await loadImageForProcessing(asset);
  const widths = buildCandidateWidths(image.bitmap.width);
  const ext = ensureFileExt(asset);
  const preferPng = imageHasTransparency(image) || ext === ".png" || ext === ".webp";
  const processingNotes = buildProcessingNotes(asset);

  for (const width of widths) {
    const resized = resizeToWidth(image, width);

    if (preferPng) {
      const pngBuffer = await encodePng(resized);
      if (pngBuffer.length <= WECHAT_BODY_IMAGE_MAX_SIZE) {
        return {
          buffer: pngBuffer,
          filename: renameWithExt(asset.filename, ".png"),
          contentType: JimpMime.png,
          wasProcessed: true,
          processingNotes: width < image.bitmap.width
            ? [...processingNotes, `resized to ${width}px wide`]
            : processingNotes,
        };
      }
    }

    for (const quality of JPEG_QUALITY_STEPS) {
      const jpegBuffer = await encodeJpeg(resized, quality);
      if (jpegBuffer.length <= WECHAT_BODY_IMAGE_MAX_SIZE) {
        const notes = [...processingNotes, `encoded as JPEG (${quality} quality)`];
        if (width < image.bitmap.width) {
          notes.push(`resized to ${width}px wide`);
        }
        return {
          buffer: jpegBuffer,
          filename: renameWithExt(asset.filename, ".jpg"),
          contentType: JimpMime.jpeg,
          wasProcessed: true,
          processingNotes: notes,
        };
      }
    }
  }

  throw new Error(`Unable to reduce ${asset.filename} below 1MB for WeChat body upload.`);
}

export async function computeImageThumbnailRgba32(
  buffer: Buffer,
  hintContentType = "",
  hintFileExt = "",
  size = 32,
): Promise<Uint8Array> {
  const detected = detectImageFormatFromBuffer(buffer);
  const contentType = detected?.contentType || hintContentType || "image/png";
  const fileExt = detected?.fileExt || hintFileExt || ".png";
  const image = await loadImageForProcessing({
    buffer,
    filename: `thumb${fileExt}`,
    contentType,
    fileExt,
    fileSize: buffer.length,
  });
  const resized = image.clone();
  resized.resize({ w: size, h: size });
  return new Uint8Array(resized.bitmap.data);
}

export function computeNormalizedRgbMae(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0 || a.length % 4 !== 0) {
    throw new Error(`Invalid RGBA buffer length for comparison: ${a.length} vs ${b.length}`);
  }
  const pixelCount = a.length / 4;
  let totalDiff = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aAlpha = a[i + 3]! / 255;
    const bAlpha = b[i + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      const aVal = a[i + c]! * aAlpha + 255 * (1 - aAlpha);
      const bVal = b[i + c]! * bAlpha + 255 * (1 - bAlpha);
      totalDiff += Math.abs(aVal - bVal) / 255;
    }
  }
  return totalDiff / (pixelCount * 3);
}
