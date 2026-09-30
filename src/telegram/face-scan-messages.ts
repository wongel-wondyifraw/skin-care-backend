import type { FaceScanInfraKind, FaceScanRejectCode } from './face-scan.types.js';

const REJECT_MESSAGES: Record<FaceScanRejectCode, string> = {
  no_face:
    'No face detected in this photo. Please send a clear front-facing selfie of your face.',
  too_dark:
    'This photo is too dark to see your skin. Please retake in brighter light (near a window or lamp), front-facing, one face.',
  too_blurry:
    'This photo is too blurry to analyze. Please hold steady, move a little closer, and try again in good light.',
  not_a_person:
    'Please send a photo of your face (a clear selfie), not an object or screenshot.',
  multiple_faces:
    'Please send a photo with only your face — one person, front-facing.',
  obscured:
    'Your face is too covered to analyze. Please remove heavy filters, masks, or anything blocking your skin, then try again.',
};

const INFRA_MESSAGES: Record<FaceScanInfraKind, string> = {
  download:
    'Couldn’t download that photo from Telegram. Please send it again.',
  gemini:
    'Analysis is temporarily unavailable. Please try again in a minute.',
  storage:
    'We analyzed your photo but couldn’t save the scan. Your advice may still appear — if not, please try once more.',
  unknown: 'Something went wrong on our side. Please try again in a moment.',
};

export function messageForRejectCode(code: FaceScanRejectCode): string {
  return REJECT_MESSAGES[code] ?? REJECT_MESSAGES.no_face;
}

export function messageForInfraKind(kind: FaceScanInfraKind): string {
  return INFRA_MESSAGES[kind] ?? INFRA_MESSAGES.unknown;
}

export function normalizeRejectCode(
  raw: string | null | undefined,
): FaceScanRejectCode {
  const c = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const allowed: FaceScanRejectCode[] = [
    'no_face',
    'too_dark',
    'too_blurry',
    'not_a_person',
    'multiple_faces',
    'obscured',
  ];
  if (allowed.includes(c as FaceScanRejectCode)) {
    return c as FaceScanRejectCode;
  }
  if (/dark|black|light|night/.test(c)) return 'too_dark';
  if (/blur/.test(c)) return 'too_blurry';
  if (/multi|crowd|group|people/.test(c)) return 'multiple_faces';
  if (/mask|cover|filter|obscur/.test(c)) return 'obscured';
  if (/person|object|animal|product/.test(c)) return 'not_a_person';
  return 'no_face';
}

/** Classify thrown errors so Telegram never blames the photo for infra issues. */
export function classifyFaceScanError(err: unknown): FaceScanInfraKind {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /Telegram file|Empty photo|fetch failed|HTTP \d+|download|AbortError|timeout/i.test(
      msg,
    )
  ) {
    return 'download';
  }
  if (
    /gemini|analyze|RESOURCE_EXHAUSTED|429|503|500|413|quota|API key|generateContent|Request too large|ITPM|high demand|Groq|Groq API/i.test(
      msg,
    )
  ) {
    return 'gemini';
  }
  if (/cloudinary|upload|storage/i.test(msg)) {
    return 'storage';
  }
  return 'unknown';
}
