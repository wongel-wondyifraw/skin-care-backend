import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Product } from '../product/product.entity.js';

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private readonly genAI: GoogleGenerativeAI;
  private readonly model: any;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is missing from .env');
    }

    const modelName =
      this.config.get<string>('GEMINI_MODEL') || 'gemini-1.5-flash';

    this.genAI = new GoogleGenerativeAI(apiKey);

    // Low temperature (0.1) suppresses hallucinated products.
    // System instruction sets closed-world context at the model level.
    this.model = this.genAI.getGenerativeModel({
      model: modelName,
      systemInstruction:
        'You are a strict product recommendation filter for Medaf Skin Care. ' +
        'You operate in a CLOSED-WORLD environment. You are strictly forbidden ' +
        'from inventing, suggesting, or mentioning any product, brand, or routine ' +
        'step that is not explicitly provided in the user inventory context.',
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
      },
    });

    this.logger.log(`Gemini service initialized with model: ${modelName}`);
  }

  /**
   * Generate personalized skincare advice based on user's skin type
   * and available products from the store.
   */
  async generateSkincareAdvice(
    userSkinType: string | null,
    allProducts: Product[],
  ): Promise<string> {
    const skinType = userSkinType || 'Not specified';
    const includeAmharic =
      (this.config.get<string>('AMHARIC_TRANSLATION') || '').toLowerCase() ===
      'true';

    // Handle edge case: empty product catalog upfront
    if (!allProducts || allProducts.length === 0) {
      return includeAmharic
        ? 'We currently do not have products in stock matching your request. Please check back later!\n\n---\n\nበአሁኑ ሰዓት ለጠየቁት ዓይነት የሚሆኑ ምርቶች በክምችት ውስጥ የሉም። እባክዎን በኋላ መልሰው ይፈትሹ!'
        : 'We currently do not have products in stock matching your request. Please check back later!';
    }

    // Build precise list of product names for explicit context anchoring
    const exactProductNames = allProducts.map((p) => `"${p.name}"`).join(', ');

    // Build detailed product list with stock status
    const productList = allProducts
      .map((p) => {
        const category = p.category?.name || 'Uncategorized';
        const suitableFor = p.skinType?.name || 'All skin types';
        const price = p.price
          ? `${Number(p.price).toFixed(2)} ETB`
          : 'Price not set';
        const stock =
          p.stock > 0 ? `In stock (${p.stock} units)` : 'OUT OF STOCK';

        return (
          `- Product Name: ${p.name}\n` +
          `  Category: ${category}\n` +
          `  Suitable for: ${suitableFor}\n` +
          `  Price: ${price}\n` +
          `  Stock status: ${stock}\n` +
          `  Description: ${p.description || 'No description'}`
        );
      })
      .join('\n\n');

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
      `Do NOT mention, suggest, or imply ANY other product, even generic ones ` +
      `(e.g., do not suggest a "moisturizer" or "sunscreen" unless it is explicitly present in the inventory list above).\n` +
      `2. If an essential skincare step (like cleansing or sun protection) has NO matching product ` +
      `in the list above, DO NOT suggest external items. Simply state that Medaf Skin Care does not ` +
      `currently have that product in stock.\n` +
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
        `- DO NOT translate brand names or category names\n` +
        `- Translate only advice, explanations, and usage instructions into Amharic\n\n` +
        `Example structure:\n` +
        `[English advice here]\n\n` +
        `---\n\n` +
        `[Amharic translation here keeping English product names]\n\n`;
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

      // Strip any remaining markdown characters
      text = this.cleanMarkdown(text);

      // Validate grounding — ensure the response references at least one real product
      text = this.validateAndSanitizeOutput(text, allProducts);

      this.logger.log(
        `Generated skincare advice for skin type: ${skinType} ` +
          `(${allProducts.length} products, bilingual: ${includeAmharic})`,
      );

      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Gemini API error: ${msg}`);
      throw new Error(
        'Failed to generate skincare advice. Please try again later.',
      );
    }
  }

  /**
   * Post-processing grounding check.
   * If the AI response doesn't mention any product from the database,
   * it almost certainly hallucinated — return a safe fallback.
   */
  private validateAndSanitizeOutput(
    response: string,
    validProducts: Product[],
  ): string {
    const mentionsValidProduct = validProducts.some((product) =>
      response.toLowerCase().includes(product.name.toLowerCase()),
    );

    if (!mentionsValidProduct) {
      this.logger.warn(
        'Gemini response failed inventory grounding check. Returning fallback.',
      );
      return (
        `✨ Welcome to Medaf Skin Care! ✨\n\n` +
        `We are currently updating our active inventory for your skin profile. ` +
        `Please explore our store catalog directly or check back shortly for updated recommendations!`
      );
    }

    return response;
  }

  /**
   * Remove markdown formatting characters from AI response.
   */
  private cleanMarkdown(text: string): string {
    return text
      .replace(/\*\*/g, '')       // bold **text**
      .replace(/\*/g, '')         // italic *text*
      .replace(/^#+\s+/gm, '')    // headers # Header
      .replace(/`/g, '')          // code backticks
      .replace(/_{2,}/g, '')      // underscores __text__
      .replace(/~~/g, '')         // strikethrough ~~text~~
      .trim();
  }
}
