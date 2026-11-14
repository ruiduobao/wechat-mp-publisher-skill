import { describe, it, expect } from 'bun:test';
import { Jimp, JimpMime } from 'jimp';
import {
  computeImageThumbnailRgba32,
  computeNormalizedRgbMae,
  prepareWechatBodyImageUpload,
  WECHAT_BODY_IMAGE_MAX_SIZE,
} from './wechat-image-processor.ts';

describe('wechat-image-processor truncated image fallback', () => {
  it('decodes a PNG truncated before IEND via Pillow fallback when Jimp fails', async () => {
    const img = new Jimp({ width: 64, height: 64, color: 0x3366ccff });
    const fullPng = await img.getBuffer(JimpMime.png);
    const iendOffset = fullPng.indexOf(Buffer.from('IEND'));
    expect(iendOffset).toBeGreaterThan(0);

    // Strip the trailing IEND chunk (and 4-byte length prefix) to trigger pngjs sync-reader failure
    const truncatedPng = fullPng.subarray(0, iendOffset - 4);
    const thumbFull = await computeImageThumbnailRgba32(fullPng, 'image/png', '.png', 32);
    const thumbTruncated = await computeImageThumbnailRgba32(truncatedPng, 'image/png', '.png', 32);

    expect(thumbTruncated.length).toBe(32 * 32 * 4);
    expect(computeNormalizedRgbMae(thumbFull, thumbTruncated)).toBeLessThan(0.01);
  });

  it('compresses an oversized (>1MB) truncated PNG below 1MB via fallback', async () => {
    const width = 1000;
    const height = 800;
    const data = Buffer.alloc(width * height * 4);
    let seed = 123456789;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = seed & 0xff;
      data[i + 1] = (seed >>> 8) & 0xff;
      data[i + 2] = (seed >>> 16) & 0xff;
      data[i + 3] = 255;
    }
    const noisy = new Jimp({ data, width, height });
    const fullPng = await noisy.getBuffer(JimpMime.png);
    expect(fullPng.length).toBeGreaterThan(WECHAT_BODY_IMAGE_MAX_SIZE);

    const iendOffset = fullPng.indexOf(Buffer.from('IEND'));
    const truncatedOversizedPng = fullPng.subarray(0, iendOffset - 4);

    const prepared = await prepareWechatBodyImageUpload({
      buffer: truncatedOversizedPng,
      filename: 'truncated-big.png',
      contentType: 'image/png',
      fileExt: '.png',
      fileSize: truncatedOversizedPng.length,
    });

    expect(prepared.wasProcessed).toBe(true);
    expect(prepared.buffer.length).toBeLessThanOrEqual(WECHAT_BODY_IMAGE_MAX_SIZE);
    expect(prepared.contentType).toBe(JimpMime.jpeg);
  });
});
