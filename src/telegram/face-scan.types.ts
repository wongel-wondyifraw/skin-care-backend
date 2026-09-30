import { Product } from '../product/product.entity.js';

/** Reject only extreme cases — not imperfect lighting. */
export type FaceScanRejectCode =
  | 'no_face'
  | 'too_dark'
  | 'too_blurry'
  | 'not_a_person'
  | 'multiple_faces'
  | 'obscured';

export type FaceScanGateJson = {
  usable: boolean;
  code?: FaceScanRejectCode | string | null;
  reason?: string | null;
};

export type FaceScanResult =
  | {
      usable: true;
      text: string;
      mentionedProducts: Product[];
      retryMessage?: undefined;
      code?: undefined;
    }
  | {
      usable: false;
      code: FaceScanRejectCode;
      retryMessage: string;
      text: string;
      mentionedProducts: Product[];
    };

export type FaceScanInfraKind =
  | 'download'
  | 'gemini'
  | 'storage'
  | 'unknown';
