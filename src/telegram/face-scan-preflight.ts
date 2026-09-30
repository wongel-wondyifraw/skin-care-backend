import sharp from 'sharp';
import type { FaceScanRejectCode } from './face-scan.types.js';
import { messageForRejectCode } from './face-scan-messages.js';

/** Mean luminance below this → pitch-black / unusable (0–255 scale). */
export const EXTREME_DARK_MEAN = 12;

/** Tiny payloads are not usable photos. */
export const MIN_PHOTO_BYTES = 200;

export type FaceScanPreflightOk = {
  ok: true;
  meanBrightness: number | null;
};

export type FaceScanPreflightReject = {
  ok: false;
  code: FaceScanRejectCode;
  retryMessage: string;
  meanBrightness?: number;
};

export type FaceScanPreflightResult =
  | FaceScanPreflightOk
  | FaceScanPreflightReject;

/**
 * Cheap local checks before calling Gemini.
 * Only rejects empty / tiny / extremely dark images — never dim-but-usable selfies.
 */
export async function runFaceScanPreflight(
  buffer: Buffer,
): Promise<FaceScanPreflightResult> {
  if (!buffer?.length || buffer.length < MIN_PHOTO_BYTES) {
    return {
      ok: false,
      code: 'too_blurry',
      retryMessage: messageForRejectCode('too_blurry'),
    };
  }

  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(64, 64, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = Math.max(1, info.channels || 3);
    const pixels = Math.floor(data.length / channels);
    if (pixels < 1) {
      return { ok: true, meanBrightness: null };
    }

    let sum = 0;
    for (let i = 0; i < data.length; i += channels) {
      if (channels >= 3) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      } else {
        sum += data[i];
      }
    }
    const mean = sum / pixels;

    if (mean < EXTREME_DARK_MEAN) {
      return {
        ok: false,
        code: 'too_dark',
        retryMessage: messageForRejectCode('too_dark'),
        meanBrightness: mean,
      };
    }

    return { ok: true, meanBrightness: mean };
  } catch {
    // Decode failure → let Gemini decide; don't block the user.
    return { ok: true, meanBrightness: null };
  }
}

/** Downscale + auto-orient for faster Gemini vision calls. */
export async function prepareFaceScanImage(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { buffer: out, mimeType: 'image/jpeg' };
  } catch {
    return { buffer, mimeType };
  }
}

/**
 * Smaller JPEG for Groq free-tier ITPM limits (image ≈ 2k tokens alone).
 * Keep Gemini on the larger prepareFaceScanImage output.
 */
export async function prepareFaceScanImageForGroq(
  buffer: Buffer,
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 65 })
      .toBuffer();
    return { buffer: out, mimeType: 'image/jpeg' };
  } catch {
    return { buffer, mimeType: 'image/jpeg' };
  }
}
