import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Product } from '../product/product.entity.js';
import {
  messageForRejectCode,
  normalizeRejectCode,
} from './face-scan-messages.js';
import {
  prepareFaceScanImage,
  runFaceScanPreflight,
} from './face-scan-preflight.js';
import type {
  FaceScanGateJson,
  FaceScanRejectCode,
  FaceScanResult,
} from './face-scan.types.js';

/** Cap inventory sent to vision analysis (in-stock preferred). */
const SCAN_CATALOG_LIMIT = 40;

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly genAI: GoogleGenerativeAI;
  private readonly model: any;
  private readonly scanModel: any;
  private readonly scanGateModel: any;
  private readonly receiptModel: any;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing from .env');

    const modelName =
      this.config.get<string>('GEMINI_MODEL') || 'gemini-2.0-flash';

    this.genAI = new GoogleGenerativeAI(apiKey);

    this.model = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction:
        'You are a strict product recommendation filter for Medaf Skin Care. ' +
        'You operate in a CLOSED-WORLD environment. You are strictly forbidden ' +
        'from inventing, suggesting, or mentioning any product, brand, or routine ' +
        'step that is not explicitly provided in the user inventory context. ' +
        'Keep answers minimal: short bullets only, never long paragraphs.',
      generationConfig: { temperature: 0.1, topP: 0.8 },
    });

    this.scanGateModel = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction:
        'You are a strict photo-quality gate for facial skincare analysis. ' +
        'Accept any photo where facial skin is at least partially visible. ' +
        'Reject only extreme cases: no face, pitch black, extreme blur, or fully obscured face. ' +
        'Always reply with JSON only.',
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        responseMimeType: 'application/json',
      },
    });

    this.scanModel = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction:
        'You are a careful visual skincare assistant for Medaf Skin Care. ' +
        'You observe facial photos, note visible concerns in short bullets, ' +
        'and recommend ONLY products from the provided Medaf catalog. ' +
        'You never invent products or give medical diagnoses. ' +
        'Keep answers minimal: short bullets only, never long paragraphs.',
      generationConfig: { temperature: 0.3, topP: 0.85 },
    });

    this.receiptModel = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction:
        'You are an accurate optical character recognition (OCR) and text extraction assistant.',
      generationConfig: { temperature: 0.0, topP: 0.8 },
    });

    this.logger.log(`Gemini service initialized with model: ${modelName}`);
  }

  /**
   * Generate personalized skincare advice and return both the text
   * and the products that were actually mentioned in the response.
   */
  async generateSkincareAdvice(
    userSkinType: string | null,
    allProducts: Product[],
  ): Promise<{ text: string; mentionedProducts: Product[] }> {
    const skinType = userSkinType || 'Not specified';
    const includeAmharic =
      (this.config.get<string>('AMHARIC_TRANSLATION') || '').toLowerCase() ===
      'true';

    if (!allProducts || allProducts.length === 0) {
      const text = includeAmharic
        ? 'We currently do not have products matching your request.\n\n---\n\nበአሁኑ ሰዓት ለጠየቁት ዓይነት ምርቶች የሉም።'
        : 'We currently do not have products matching your request. Please check back later!';
      return { text, mentionedProducts: [] };
    }

    const exactProductNames = allProducts.map((p) => `"${p.name}"`).join(', ');
    const productList = this.formatProductInventory(allProducts);

    let prompt =
      `CRITICAL DIRECTIVE — CLOSED WORLD INVENTORY ONLY:\n` +
      `You are an inventory-bound recommendation assistant for Medaf Skin Care.\n\n` +
      `CUSTOMER SKIN TYPE: ${skinType}\n\n` +
      `EXACT ALLOWED PRODUCTS (${allProducts.length} TOTAL):\n` +
      `[ ${exactProductNames} ]\n\n` +
      `DETAILED INVENTORY DATA:\n` +
      `${productList}\n\n` +
      `STRICT COMPLIANCE RULES:\n` +
      `1. ABSOLUTE ZERO HALLUCINATION RULE: Recommend ONLY products from the exact list above. ` +
      `Do NOT mention, suggest, or imply ANY other product, even generic ones.\n` +
      `2. If an essential skincare step has NO matching product in the list above, ` +
      `DO NOT suggest external items. Simply state that Medaf Skin Care does not currently have it.\n` +
      `3. For each product you recommend, use its EXACT listed name.\n` +
      `4. If a listed product is OUT OF STOCK, state its out-of-stock status clearly.\n` +
      `5. Base recommendations on suitability for skin type: ${skinType}.\n\n` +
      `TASK (KEEP SHORT):\n` +
      `1. Recommend only the best-fit products from the inventory (prefer 2–4 items).\n` +
      `2. For EACH recommended product, give ONE short bullet with the product name + its main benefit for ${skinType} skin.\n` +
      `3. Optionally add a tiny morning/evening order as short bullets (product names only).\n` +
      `4. Do NOT write paragraphs, essays, long routines, or bulk explanations.\n\n` +
      `OUTPUT FORMAT (plain text, no markdown like *, **, #):\n` +
      `Recommendations\n` +
      `- <Exact Product Name> — <one short benefit>\n` +
      `- <Exact Product Name> — <one short benefit>\n` +
      `Routine (optional)\n` +
      `- Morning: <product>, <product>\n` +
      `- Evening: <product>, <product>\n` +
      `Rules:\n` +
      `- Bullets only; each bullet max ~12 words\n` +
      `- Focus on product benefit, not long how-to\n` +
      `- Light emojis only in section titles if helpful\n` +
      `- Easy to read on Telegram mobile\n\n`;

    if (includeAmharic) {
      prompt +=
        `BILINGUAL RESPONSE REQUIRED:\n` +
        `- English section first (same bullet format)\n` +
        `- Then a line with only ---\n` +
        `- Then Amharic section with the SAME bullet structure\n` +
        `- Keep exact product names in English (never translate product names)\n` +
        `- Keep technical skincare terms in English when there is no clear everyday Amharic word ` +
        `(examples: moisturizer, serum, cleanser, toner, SPF, sunscreen, niacinamide, retinol, hyaluronic acid, pH)\n` +
        `- If any phrase has no natural/direct Amharic translation, KEEP THAT PHRASE IN ENGLISH inside the Amharic section\n` +
        `- Do not invent awkward Amharic for technical words; prefer English\n` +
        `- Amharic bullets must stay short and simple like the English ones\n\n`;
    }

    if (userSkinType === null) {
      prompt +=
        `Note: Customer skin type is "Not specified". Recommend versatile in-stock products ` +
        `suitable for general skin types, still using the short bullet format.`;
    }

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      let text: string = String(response.text());

      text = this.cleanMarkdown(text);
      text = this.validateAndSanitizeOutput(text, allProducts);

      // ── Match products by scanning the advice text directly ──────
      // No second API call needed — just check which DB product names
      // appear verbatim in the response text.
      const mentionedProducts = allProducts.filter((p) =>
        text.toLowerCase().includes(p.name.toLowerCase()),
      );

      this.logger.log(
        `Advice generated for skin type: ${skinType} | ` +
          `${allProducts.length} products considered | ` +
          `${mentionedProducts.length} mentioned in response`,
      );

      return { text, mentionedProducts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Gemini API error: ${msg}`);
      throw new Error(
        'Failed to generate skincare advice. Please try again later.',
      );
    }
  }

  async analyzeFaceScan(input: {
    imageBuffer: Buffer;
    mimeType: string;
    userSkinType: string | null;
    products: Product[];
  }): Promise<FaceScanResult> {
    const preflight = await runFaceScanPreflight(input.imageBuffer);
    if (!preflight.ok) {
      return {
        usable: false,
        code: preflight.code,
        retryMessage: preflight.retryMessage,
        text: preflight.retryMessage,
        mentionedProducts: [],
      };
    }

    const prepared = await prepareFaceScanImage(
      input.imageBuffer,
      input.mimeType || 'image/jpeg',
    );

    const gate = await this.runFaceScanGate(prepared.buffer, prepared.mimeType);
    if (!gate.usable) {
      const code = normalizeRejectCode(gate.code);
      const retryMessage = messageForRejectCode(code);
      return {
        usable: false,
        code,
        retryMessage,
        text: retryMessage,
        mentionedProducts: [],
      };
    }

    const skinType = input.userSkinType || 'Not specified';
    const includeAmharic =
      (this.config.get<string>('AMHARIC_TRANSLATION') || '').toLowerCase() ===
      'true';
    const products = this.trimCatalogForScan(input.products ?? []);
    const exactProductNames = products.map((p) => `"${p.name}"`).join(', ');
    const productList = this.formatProductInventory(products);

    let prompt =
      `You are analyzing a customer's facial photo for Medaf Skin Care.\n` +
      `The photo has already passed quality checks — analyze the visible facial skin.\n\n` +
      `VISUAL FINDINGS:\n` +
      `List only clear visible concerns as short bullets (max 4 bullets).\n` +
      `Mention region when useful (forehead, cheeks, nose, chin, under-eye).\n` +
      `Possible concerns: dark spots, uneven tone, pimples/acne, redness, dryness, oiliness, pores, dark circles.\n` +
      `This is NOT a medical diagnosis. If severe, add one short line to see a dermatologist.\n\n` +
      `PRODUCT RECOMMENDATIONS:\n` +
      `Customer stated skin type: ${skinType}\n` +
      `Recommend ONLY products from this closed-world Medaf catalog (prefer 2–4 in-stock items).\n` +
      `EXACT ALLOWED PRODUCTS: [ ${exactProductNames || 'none'} ]\n\n` +
      `INVENTORY:\n${productList || 'No products in catalog.'}\n\n` +
      `Do not invent brands or products. ` +
      `If a needed step has no matching product, say Medaf does not currently have it.\n\n` +
      `OUTPUT FORMAT (plain text, no markdown like *, **, #):\n` +
      `Observed\n` +
      `- <short finding>\n` +
      `Recommendations\n` +
      `- <Exact Product Name> — <one short benefit for this photo/skin>\n` +
      `- <Exact Product Name> — <one short benefit>\n` +
      `Rules:\n` +
      `- Bullets only; each bullet max ~12 words\n` +
      `- Minimal explanation; focus on product benefit\n` +
      `- No long paragraphs or bulk care essays\n` +
      `- Keep concise for Telegram\n`;

    if (includeAmharic) {
      prompt +=
        `\nBILINGUAL RESPONSE REQUIRED:\n` +
        `- English section first in the bullet format above\n` +
        `- Then a line with only ---\n` +
        `- Then Amharic section with the SAME short bullet structure\n` +
        `- Keep exact product names in English\n` +
        `- Keep technical skincare terms in English when there is no clear everyday Amharic word ` +
        `(moisturizer, serum, cleanser, toner, SPF, sunscreen, niacinamide, retinol, hyaluronic acid, pH, etc.)\n` +
        `- If any phrase has no natural/direct Amharic translation, KEEP THAT PHRASE IN ENGLISH inside the Amharic section\n` +
        `- Do not invent awkward Amharic for technical words; prefer English\n`;
    }

    try {
      const rawText = await this.withGeminiRetry(async () => {
        const result = await this.scanModel.generateContent([
          { text: prompt },
          {
            inlineData: {
              mimeType: prepared.mimeType,
              data: prepared.buffer.toString('base64'),
            },
          },
        ]);
        const response = await result.response;
        return String(response.text() || '');
      });

      let text = this.cleanMarkdown(rawText)
        .replace(/PHOTO_OK/gi, '')
        .replace(/PHOTO_UNCLEAR/gi, '')
        .trim();

      if (products.length > 0) {
        text = this.validateAndSanitizeOutput(text, products);
      }

      const mentionedProducts = products.filter((p) =>
        text.toLowerCase().includes(p.name.toLowerCase()),
      );

      return { usable: true, text, mentionedProducts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Gemini face scan analysis error: ${msg}`);
      throw new Error(
        `Failed to analyze the photo via Gemini: ${msg.slice(0, 200)}`,
      );
    }
  }

  /** Prefer in-stock items; cap size to reduce tokens / rate pressure. */
  private trimCatalogForScan(products: Product[]): Product[] {
    const inStock = products.filter((p) => Number(p.stock) > 0);
    const pool = inStock.length > 0 ? inStock : products;
    return pool.slice(0, SCAN_CATALOG_LIMIT);
  }

  private async runFaceScanGate(
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ usable: boolean; code?: FaceScanRejectCode }> {
    const prompt =
      `Decide if this photo can be used for light facial skincare observation.\n\n` +
      `ACCEPT (usable=true) when:\n` +
      `- A human face is visible enough to see some facial skin\n` +
      `- Glasses, everyday makeup, soft shadows, cropped forehead, slight angle, or imperfect indoor light are OK\n` +
      `- When unsure, ACCEPT\n\n` +
      `REJECT (usable=false) ONLY for extremes:\n` +
      `- no_face: no human face in frame\n` +
      `- too_dark: pitch black / face completely invisible from darkness\n` +
      `- too_blurry: extreme motion blur, face unrecognizable\n` +
      `- not_a_person: object, animal, product, screenshot without a face\n` +
      `- multiple_faces: several people; cannot focus on one face\n` +
      `- obscured: heavy opaque mask/filter fully covering skin\n\n` +
      `Examples:\n` +
      `- Dim indoor selfie with visible cheeks → usable true\n` +
      `- Black frame / pocket photo → usable false, code too_dark\n` +
      `- Empty room / bottle only → usable false, code no_face\n\n` +
      `Return ONLY JSON:\n` +
      `{"usable":true|false,"code":"no_face"|"too_dark"|"too_blurry"|"not_a_person"|"multiple_faces"|"obscured"|null,"reason":"short"}`;

    try {
      const rawText = await this.withGeminiRetry(async () => {
        const result = await this.scanGateModel.generateContent([
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: buffer.toString('base64'),
            },
          },
        ]);
        const response = await result.response;
        return String(response.text() || '');
      });

      const parsed = this.parseFaceScanGate(rawText);
      if (!parsed) {
        // Prefer accept on parse failure so we don't false-reject real selfies.
        this.logger.warn(
          `Face scan gate parse failed — accepting photo. Raw: ${rawText.slice(0, 120)}`,
        );
        return { usable: true };
      }

      if (parsed.usable) return { usable: true };

      return {
        usable: false,
        code: normalizeRejectCode(parsed.code),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Gemini face scan gate error: ${msg}`);
      throw new Error(
        `Failed to analyze the photo via Gemini: ${msg.slice(0, 200)}`,
      );
    }
  }

  /** Exported for unit tests — parse gate JSON (or legacy PHOTO_* flags). */
  parseFaceScanGate(raw: string): FaceScanGateJson | null {
    const text = String(raw || '').trim();
    if (!text) return null;

    try {
      const cleaned = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<
          string,
          unknown
        >;
        const usable = Boolean(obj.usable);
        return {
          usable,
          code: obj.code != null ? String(obj.code) : null,
          reason: obj.reason != null ? String(obj.reason) : null,
        };
      }
    } catch {
      // fall through
    }

    const upper = text.toUpperCase();
    if (upper.includes('PHOTO_UNCLEAR') && !upper.includes('PHOTO_OK')) {
      return { usable: false, code: 'no_face', reason: 'legacy flag' };
    }
    if (upper.includes('PHOTO_OK')) {
      return { usable: true, code: null, reason: null };
    }

    // If the model returned advice-like text without JSON, treat as usable.
    if (
      /observed|recommendation|skin|forehead|cheek|acne|spot/i.test(text) &&
      text.length > 40
    ) {
      return { usable: true, code: null, reason: 'advice-like fallback' };
    }

    return null;
  }

  private async withGeminiRetry<T>(
    fn: () => Promise<T>,
    retries = 1,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        /429|503|500|RESOURCE_EXHAUSTED|unavailable|timeout|ECONNRESET|fetch failed/i.test(
          msg,
        );
      if (retries > 0 && transient) {
        this.logger.warn(`Gemini transient error — retrying once: ${msg}`);
        await new Promise((r) => setTimeout(r, 900));
        return this.withGeminiRetry(fn, retries - 1);
      }
      throw err;
    }
  }

  private formatProductInventory(allProducts: Product[]): string {
    return allProducts
      .map((p) => {
        const category = p.category?.name || 'Uncategorized';
        const suitableFor = p.skinTypes?.length
          ? p.skinTypes.map((s) => s.name).join(', ')
          : p.skinType?.name || 'All skin types';
        const brand = p.brand?.trim() ? `  Brand: ${p.brand.trim()}\n` : '';
        const price = p.price
          ? `${Number(p.price).toFixed(2)} ETB`
          : 'Price not set';
        const stock =
          p.stock > 0 ? `In stock (${p.stock} units)` : 'OUT OF STOCK';

        return (
          `- Product Name: ${p.name}\n` +
          brand +
          `  Category: ${category}\n` +
          `  Suitable for: ${suitableFor}\n` +
          `  Price: ${price}\n` +
          `  Stock status: ${stock}\n` +
          `  Description: ${p.description || 'No description'}`
        );
      })
      .join('\n\n');
  }

  /**
   * Post-processing grounding check.
   */
  private validateAndSanitizeOutput(
    response: string,
    validProducts: Product[],
  ): string {
    const mentionsValidProduct = validProducts.some((p) =>
      response.toLowerCase().includes(p.name.toLowerCase()),
    );

    if (!mentionsValidProduct) {
      this.logger.warn(
        'Gemini response failed inventory grounding check. Returning fallback.',
      );
      return (
        `✨ Welcome to Medaf Skin Care! ✨\n\n` +
        `We are currently updating our active inventory for your skin profile. ` +
        `Please explore our store catalog directly or check back shortly!`
      );
    }

    return response;
  }

  private cleanMarkdown(text: string): string {
    return text
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/^#+\s+/gm, '')
      .replace(/`/g, '')
      .replace(/_{2,}/g, '')
      .replace(/~~/g, '')
      .trim();
  }

  /**
   * Identify CBE vs Telebirr from the receipt image, then extract the transaction number.
   * Branding/names drive bank detection — not the user's selected method.
   */
  async extractReceiptPayment(input: {
    url?: string;
    buffer?: Buffer;
    text?: string;
  }): Promise<{
    bank: 'cbe' | 'telebirr' | 'unknown';
    transactionNumber: string | null;
    confidence: 'high' | 'medium' | 'low';
    signals: string[];
  }> {
    const prompt = `You analyze Ethiopian mobile-money / bank transfer receipts.

STEP 1 — Identify which app/bank issued this receipt by searching visible names, logos, and UI text:
- "cbe" if you see: Commercial Bank of Ethiopia, CBE, CBE Birr, CBE Mobile Banking, CBEServe, or similar CBE branding.
- "telebirr" if you see: telebirr, Telebirr, Ethio telecom, ethio telecom wallet branding.
- "unknown" only if neither is clear.

STEP 2 — Extract the transaction / reference number with bank-specific rules:
- If bank is cbe: prefer an FT reference (starts with FT, usually ALL CAPS alphanumeric, e.g. FT25123ABCDEF). Prefer labeled FT Number / Transaction ID / Reference. Ignore account numbers, phones, amounts, dates.
- If bank is telebirr: prefer labeled Transaction number / Transaction ID / Receipt No (alphanumeric like DET8FJGUJ4). Ignore phone numbers (09…), amounts, dates.
- If bank is unknown: still try to extract — if the token starts with FT treat as CBE-style; otherwise take the clearest transaction/reference ID.

Return ONLY valid JSON (no markdown fences):
{"bank":"cbe"|"telebirr"|"unknown","transactionNumber":"STRING_OR_NULL","confidence":"high"|"medium"|"low","signals":["short phrases you saw"]}

If no transaction number is found, set transactionNumber to null.`;

    const empty = {
      bank: 'unknown' as const,
      transactionNumber: null,
      confidence: 'low' as const,
      signals: [] as string[],
    };

    try {
      let buffer = input.buffer;
      let mimeType = 'image/jpeg';

      if (input.url && input.url.startsWith('http')) {
        const res = await fetch(input.url, {
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) {
          buffer = Buffer.from(await res.arrayBuffer());
          const ct = res.headers.get('content-type')?.split(';')[0]?.trim();
          if (ct?.startsWith('image/')) {
            mimeType = ct;
          } else {
            mimeType = this.guessImageMime(input.url);
          }
        }
      }

      let rawText = '';
      if (buffer) {
        const result = await this.receiptModel.generateContent([
          prompt,
          {
            inlineData: {
              data: buffer.toString('base64'),
              mimeType,
            },
          },
        ]);
        rawText = result.response.text();
      } else if (input.text) {
        const result = await this.receiptModel.generateContent([
          prompt,
          input.text,
        ]);
        rawText = result.response.text();
      } else {
        return empty;
      }

      return this.parseReceiptExtract(rawText);
    } catch (err) {
      this.logger.error(`Failed to extract receipt payment via Gemini: ${err}`);
      return empty;
    }
  }

  /** @deprecated Prefer extractReceiptPayment — kept for callers that only need a TX string. */
  async extractTransactionNumber(input: {
    url?: string;
    buffer?: Buffer;
    text?: string;
    paymentMethod: 'bank' | 'telebirr';
  }): Promise<string | null> {
    const receipt = await this.extractReceiptPayment(input);
    return receipt.transactionNumber;
  }

  private parseReceiptExtract(raw: string): {
    bank: 'cbe' | 'telebirr' | 'unknown';
    transactionNumber: string | null;
    confidence: 'high' | 'medium' | 'low';
    signals: string[];
  } {
    const empty = {
      bank: 'unknown' as const,
      transactionNumber: null,
      confidence: 'low' as const,
      signals: [] as string[],
    };

    let parsed: Record<string, unknown> | null = null;
    try {
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<
          string,
          unknown
        >;
      }
    } catch {
      // Fall through to TX-only salvage
    }

    let bank: 'cbe' | 'telebirr' | 'unknown' = 'unknown';
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let signals: string[] = [];
    let tx: string | null = null;

    if (parsed) {
      const b = String(parsed.bank || '').toLowerCase();
      if (b === 'cbe' || b === 'bank') bank = 'cbe';
      else if (b === 'telebirr') bank = 'telebirr';
      const c = String(parsed.confidence || '').toLowerCase();
      if (c === 'high' || c === 'medium' || c === 'low') confidence = c;
      if (Array.isArray(parsed.signals)) {
        signals = parsed.signals.map((s) => String(s)).slice(0, 8);
      }
      tx = this.normalizeExtractedTx(String(parsed.transactionNumber ?? ''));
    } else {
      tx = this.normalizeExtractedTx(raw);
    }

    // Secondary signal from TX shape when branding unknown
    if (bank === 'unknown' && tx) {
      if (/^FT[A-Z0-9]+$/i.test(tx)) {
        bank = 'cbe';
        confidence = confidence === 'low' ? 'medium' : confidence;
        signals = [...signals, 'FT prefix'];
      }
    }

    if (bank === 'cbe' && tx) {
      tx = tx.toUpperCase();
    }

    return {
      bank,
      transactionNumber: tx,
      confidence,
      signals,
    };
  }

  private normalizeExtractedTx(raw: string): string | null {
    const text = raw
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^(transaction|reference|ref|tx|id)\s*[:=#-]?\s*/i, '')
      .trim();
    if (!text || /^not[_\s-]?found$/i.test(text) || text === 'null') {
      return null;
    }
    const ft = text.match(/FT[A-Z0-9]{6,}/i);
    if (ft) return ft[0].toUpperCase();
    const match = text.match(/[A-Za-z0-9][A-Za-z0-9_./-]{5,}/);
    return match ? match[0] : text.length >= 6 ? text.split(/\s+/)[0] : null;
  }

  private guessImageMime(url: string): string {
    const path = url.split('?')[0].toLowerCase();
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
  }
}
