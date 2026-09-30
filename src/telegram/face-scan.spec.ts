import {
  classifyFaceScanError,
  messageForInfraKind,
  messageForRejectCode,
  normalizeRejectCode,
} from './face-scan-messages';
import {
  EXTREME_DARK_MEAN,
  MIN_PHOTO_BYTES,
  prepareFaceScanImage,
  prepareFaceScanImageForGroq,
  runFaceScanPreflight,
} from './face-scan-preflight';
import { GeminiService } from './gemini.service';
import sharp from 'sharp';

describe('face-scan-messages', () => {
  it('maps reject codes to specific copy', () => {
    expect(messageForRejectCode('no_face')).toMatch(/No face/i);
    expect(messageForRejectCode('too_dark')).toMatch(/too dark/i);
  });

  it('normalizes fuzzy codes', () => {
    expect(normalizeRejectCode('TOO_DARK')).toBe('too_dark');
    expect(normalizeRejectCode('blurry-mess')).toBe('too_blurry');
    expect(normalizeRejectCode('unknown_xyz')).toBe('no_face');
  });

  it('classifies infra errors without blaming the photo', () => {
    expect(classifyFaceScanError(new Error('Telegram file HTTP 403'))).toBe(
      'download',
    );
    expect(
      classifyFaceScanError(new Error('Failed to analyze via Gemini: 429')),
    ).toBe('gemini');
    expect(
      classifyFaceScanError(
        new Error('Groq API 413: Request too large ITPM Limit 7000'),
      ),
    ).toBe('gemini');
    expect(classifyFaceScanError(new Error('Cloudinary upload failed'))).toBe(
      'storage',
    );
    expect(messageForInfraKind('gemini')).toMatch(/temporarily unavailable/i);
    expect(messageForInfraKind('gemini')).not.toMatch(/clearer/i);
  });
});

describe('face-scan-preflight', () => {
  it('rejects empty / tiny buffers', async () => {
    const r = await runFaceScanPreflight(Buffer.alloc(10));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_blurry');
  });

  it('rejects extremely dark images', async () => {
    // Add slight noise so JPEG isn't tiny; luminance still near-black.
    const black = await sharp({
      create: {
        width: 128,
        height: 128,
        channels: 3,
        background: { r: 2, g: 2, b: 2 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const r = await runFaceScanPreflight(black);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('too_dark');
      expect(r.meanBrightness ?? 0).toBeLessThan(EXTREME_DARK_MEAN);
    }
  });

  it('accepts a reasonably lit image', async () => {
    const lit = await sharp({
      create: {
        width: 320,
        height: 320,
        channels: 3,
        background: { r: 180, g: 160, b: 140 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    expect(lit.length).toBeGreaterThan(MIN_PHOTO_BYTES);
    const r = await runFaceScanPreflight(lit);
    expect(r.ok).toBe(true);
  });

  it('prepares a smaller JPEG for Groq than for Gemini', async () => {
    const src = await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 120, g: 100, b: 90 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const gemini = await prepareFaceScanImage(src, 'image/jpeg');
    const groq = await prepareFaceScanImageForGroq(src);
    expect(groq.mimeType).toBe('image/jpeg');
    expect(groq.buffer.length).toBeLessThan(gemini.buffer.length);
  });
});

describe('GeminiService.parseFaceScanGate', () => {
  const svc = Object.create(GeminiService.prototype) as GeminiService;

  it('parses JSON usable true', () => {
    const g = svc.parseFaceScanGate(
      '{"usable":true,"code":null,"reason":"ok"}',
    );
    expect(g).toEqual({
      usable: true,
      code: null,
      reason: 'ok',
    });
  });

  it('parses JSON reject with code', () => {
    const g = svc.parseFaceScanGate(
      '```json\n{"usable":false,"code":"too_dark","reason":"black"}\n```',
    );
    expect(g?.usable).toBe(false);
    expect(g?.code).toBe('too_dark');
  });

  it('falls back PHOTO_OK / PHOTO_UNCLEAR', () => {
    expect(svc.parseFaceScanGate('PHOTO_OK\nObserved\n- acne').usable).toBe(
      true,
    );
    expect(svc.parseFaceScanGate('PHOTO_UNCLEAR\nToo dark').usable).toBe(
      false,
    );
  });

  it('treats advice-like text as usable when JSON missing', () => {
    const g = svc.parseFaceScanGate(
      'Observed\n- forehead spots\nRecommendations\n- Serum for skin',
    );
    expect(g?.usable).toBe(true);
  });
});
