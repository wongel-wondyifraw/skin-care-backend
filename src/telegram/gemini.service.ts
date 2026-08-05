import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Product } from '../product/product.entity.js';

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly genAI: GoogleGenerativeAI;
  private readonly model: any;
  private readonly scanModel: any;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing from .env');

    const modelName =
      this.config.get<string>('GEMINI_MODEL') || 'gemini-1.5-flash';

    this.genAI = new GoogleGenerativeAI(apiKey);

    this.model = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction:
        'You are a strict product recommendation filter for Medaf Skin Care. ' +
        'You operate in a CLOSED-WORLD environment. You are strictly forbidden ' +
        'from inventing, suggesting, or mentioning any product, brand, or routine ' +
        'step that is not explicitly provided in the user inventory context.',
      generationConfig: { temperature: 0.1, topP: 0.8 },
    });

    this.scanModel = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction:
        'You are a careful visual skincare assistant for Medaf Skin Care. ' +
        'You observe facial photos, describe visible skin concerns, give gentle advice, ' +
        'and recommend ONLY products from the provided Medaf catalog. ' +
        'You never invent products or give medical diagnoses.',
      generationConfig: { temperature: 0.3, topP: 0.85 },
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
      `TASK:\n` +
      `1. Construct a simple morning/evening routine using ONLY available items from the inventory list above.\n` +
      `2. For each product used, explain briefly why it suits ${skinType} skin and how to use it.\n\n` +
      `FORMATTING RULES:\n` +
      `- DO NOT use markdown characters like *, **, #, ##, or ###\n` +
      `- Use plain text only with clean line breaks and spacing\n` +
      `- Use emojis (e.g. 🌅, 🌙, 💧, ✨, 🌿) for visual sections\n` +
      `- Keep it friendly, warm, conversational, and easy to read on mobile screens\n\n`;

    if (includeAmharic) {
      prompt +=
        `BILINGUAL RESPONSE REQUIRED:\n` +
        `- Provide the ENTIRE response in BOTH English and Amharic\n` +
        `- Structure: English section first, then "---" on its own line, then Amharic section\n` +
        `- DO NOT translate product names (keep exact English product names as-is)\n` +
        `- DO NOT translate technical terms (e.g., "moisturizer", "serum", "SPF", "pH")\n` +
        `- Translate only advice, explanations, and usage instructions into Amharic\n\n`;
    }

    if (userSkinType === null) {
      prompt +=
        `Note: Customer skin type is "Not specified". Provide versatile advice ` +
        `using the available products suitable for general skin types.`;
    }

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      let text = response.text();

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
  }): Promise<{
    usable: boolean;
    retryMessage?: string;
    text: string;
    mentionedProducts: Product[];
  }> {
    const skinType = input.userSkinType || 'Not specified';
    const includeAmharic =
      (this.config.get<string>('AMHARIC_TRANSLATION') || '').toLowerCase() ===
      'true';
    const products = input.products ?? [];
    const exactProductNames = products.map((p) => `"${p.name}"`).join(', ');
    const productList = this.formatProductInventory(products);

    let prompt =
      `You are analyzing a customer's facial photo for Medaf Skin Care.\n\n` +
      `STEP 1 — PHOTO QUALITY GATE:\n` +
      `Reject the photo if ANY of these are true:\n` +
      `- not a human face, face too small/cropped, blurry, too dark or overexposed,\n` +
      `- heavy filter/makeup hiding the skin, group photo, screenshot/text, or unrelated object.\n\n` +
      `If rejected, reply with EXACTLY this format and nothing else before the message:\n` +
      `PHOTO_UNCLEAR\n` +
      `Then 1-3 short friendly sentences telling the user what to fix ` +
      `(better light, front-facing, one face, closer, no filter).\n\n` +
      `If the photo is usable, start with this exact first line:\n` +
      `PHOTO_OK\n\n` +
      `STEP 2 — VISUAL FINDINGS (only if PHOTO_OK):\n` +
      `Describe what is visible by region when possible (forehead, cheeks, nose, chin, under-eye):\n` +
      `- discoloration / dark spots / hyperpigmentation / uneven tone\n` +
      `- pimples / acne / whiteheads / blackheads\n` +
      `- red spots / redness / irritation / inflammation\n` +
      `- dryness / flaking / oiliness / visible pores\n` +
      `- anything else clearly visible (e.g. dark circles)\n` +
      `Be observational and humble. This is NOT a medical diagnosis. ` +
      `Suggest seeing a dermatologist for severe or persistent issues.\n\n` +
      `STEP 3 — ADVICE + PRODUCTS:\n` +
      `Customer stated skin type: ${skinType}\n` +
      `Recommend ONLY products from this closed-world Medaf catalog.\n` +
      `EXACT ALLOWED PRODUCTS: [ ${exactProductNames || 'none'} ]\n\n` +
      `INVENTORY:\n${productList || 'No products in catalog.'}\n\n` +
      `Prefer in-stock items. Do not invent brands or products. ` +
      `If a needed step has no matching product, say Medaf does not currently have it.\n\n` +
      `FORMAT (plain text, no markdown like *, **, #):\n` +
      `Observed on your photo\n` +
      `Care tips\n` +
      `Products from our catalog\n` +
      `Keep it concise for Telegram. Use light emojis if helpful.\n`;

    if (includeAmharic) {
      prompt +=
        `\nAlso provide an Amharic translation after a line with only ---.\n` +
        `Keep product names in English.\n`;
    }

    try {
      const result = await this.scanModel.generateContent([
        { text: prompt },
        {
          inlineData: {
            mimeType: input.mimeType || 'image/jpeg',
            data: input.imageBuffer.toString('base64'),
          },
        },
      ]);
      const response = await result.response;
      let raw = this.cleanMarkdown(response.text() || '');

      const firstLine = raw.split(/\r?\n/, 1)[0]?.trim().toUpperCase() ?? '';
      const rest = raw.replace(/^[^\n]*\n?/, '').trim();

      if (firstLine.includes('PHOTO_UNCLEAR') || !firstLine.includes('PHOTO_OK')) {
        const retryMessage =
          rest ||
          'Please send a clearer front-facing photo in good light — one face, no heavy filter.';
        return {
          usable: false,
          retryMessage,
          text: retryMessage,
          mentionedProducts: [],
        };
      }

      let text = rest || raw.replace(/^PHOTO_OK\s*/i, '').trim();
      if (products.length > 0) {
        text = this.validateAndSanitizeOutput(text, products);
      }

      const mentionedProducts = products.filter((p) =>
        text.toLowerCase().includes(p.name.toLowerCase()),
      );

      return { usable: true, text, mentionedProducts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Gemini face scan error: ${msg}`);
      throw new Error('Failed to analyze the photo. Please try again later.');
    }
  }

  private formatProductInventory(allProducts: Product[]): string {
    return allProducts
      .map((p) => {
        const category = p.category?.name || 'Uncategorized';
        const suitableFor =
          p.skinTypes?.length
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

  /**
   * Remove markdown formatting characters from AI response.
   */
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
}
