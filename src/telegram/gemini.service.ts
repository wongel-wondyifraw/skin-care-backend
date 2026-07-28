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
    const modelName = this.config.get<string>('GEMINI_MODEL') || 'gemini-1.5-flash';
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: modelName });
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
      (this.config.get<string>('AMHARIC_TRANSLATION') || '').toLowerCase() === 'true';

    // Build product list with skin type categorization and stock status
    const productList = allProducts
      .map((p) => {
        const category = p.category?.name || 'Uncategorized';
        const suitableFor = p.skinType?.name || 'All skin types';
        const price = p.price ? `${Number(p.price).toFixed(2)} ETB` : 'Price not set';
        const stock = p.stock > 0 ? `In stock (${p.stock} units)` : 'OUT OF STOCK';

        return (
          `- ${p.name}\n` +
          `  Category: ${category}\n` +
          `  Suitable for: ${suitableFor}\n` +
          `  Price: ${price}\n` +
          `  Stock: ${stock}\n` +
          `  Description: ${p.description || 'No description'}`
        );
      })
      .join('\n\n');

    let prompt =
      `You are a professional skincare consultant at Medaf Skin Care.\n\n` +
      `A customer with ${skinType} skin type is asking for personalized skincare advice.\n\n` +
      `Here are the ONLY products currently available in our store:\n\n` +
      `${productList}\n\n` +
      `STRICT RULES — YOU MUST FOLLOW THESE:\n` +
      `- You MUST ONLY recommend products from the list above. Do NOT invent, suggest, or mention any product that is not in the list above.\n` +
      `- If a product name is not in the list above, do NOT include it in your response under any circumstances.\n` +
      `- Do NOT say things like "you could also try a moisturizer" unless a moisturizer is explicitly in the list above.\n` +
      `- Only recommend what is actually listed. If only one product is available, recommend only that one.\n\n` +
      `Based on the customer's skin type (${skinType}), please:\n` +
      `1. Recommend a simple daily skincare routine (morning and evening) using ONLY the products listed above.\n` +
      `2. For each product you recommend, explain WHY it is suitable and how to use it.\n` +
      `3. If a product is OUT OF STOCK, mention it clearly and suggest they check back later or contact us.\n` +
      `4. Keep the tone friendly, warm, and professional.\n\n` +
      `IMPORTANT FORMATTING RULES:\n` +
      `- DO NOT use markdown syntax like *, **, #, ##, or ###\n` +
      `- Use plain text only with emojis for visual appeal\n` +
      `- Use line breaks and spacing for readability\n` +
      `- Use emojis like 🌅 🌙 💧 ✨ 🌿 to make sections clear\n` +
      `- Keep it conversational and easy to read on mobile\n\n`;

    if (includeAmharic) {
      prompt +=
        `BILINGUAL RESPONSE REQUIRED:\n` +
        `- Provide the ENTIRE response in BOTH English and Amharic\n` +
        `- Structure: English section first, then a separator line, then Amharic section\n` +
        `- DO NOT translate product names (e.g., keep "Hydrating Cleanser" as is)\n` +
        `- DO NOT translate technical terms (e.g., "moisturizer", "serum", "SPF", "pH")\n` +
        `- DO NOT translate brand names or category names\n` +
        `- Translate only the advice, explanations, and routine instructions\n` +
        `- Use "---" as a separator between English and Amharic sections\n\n` +
        `Example structure:\n` +
        `[English advice here]\n\n` +
        `---\n\n` +
        `[Amharic translation here with product names kept in English]\n\n`;
    }

    prompt += `If the customer's skin type is "Not specified", provide general skincare tips that work for most skin types and recommend versatile products.`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      let text = response.text();

      // Clean up any remaining markdown characters
      text = this.cleanMarkdown(text);

      this.logger.log(
        `Generated skincare advice for skin type: ${skinType} (${allProducts.length} products, bilingual: ${includeAmharic})`,
      );

      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Gemini API error: ${msg}`);
      throw new Error('Failed to generate skincare advice. Please try again later.');
    }
  }

  /**
   * Remove markdown formatting characters from AI response.
   */
  private cleanMarkdown(text: string): string {
    return text
      .replace(/\*\*/g, '') // Remove bold **text**
      .replace(/\*/g, '') // Remove italic *text*
      .replace(/^#+\s+/gm, '') // Remove headers # Header
      .replace(/`/g, '') // Remove code backticks
      .replace(/_{2,}/g, '') // Remove underscores __text__
      .replace(/~~/g, '') // Remove strikethrough ~~text~~
      .trim();
  }
}
