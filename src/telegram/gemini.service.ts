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
    this.genAI = new GoogleGenerativeAI(apiKey);
    // Use gemini-1.5-flash (faster) or gemini-1.5-pro (more capable)
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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

    // Build product list with skin type categorization
    const productList = allProducts
      .map((p) => {
        const category = p.category?.name || 'Uncategorized';
        const suitableFor = p.skinType?.name || 'All skin types';
        const price = p.price ? `${Number(p.price).toFixed(2)} ETB` : 'Price not set';
        const stock = p.stock > 0 ? 'In stock' : 'Out of stock';

        return (
          `- ${p.name}\n` +
          `  Category: ${category}\n` +
          `  Suitable for: ${suitableFor}\n` +
          `  Price: ${price} | ${stock}\n` +
          `  Description: ${p.description || 'No description'}`
        );
      })
      .join('\n\n');

    const prompt =
      `You are a professional skincare consultant at Medaf Skin Care.\n\n` +
      `A customer with **${skinType}** skin type is asking for personalized skincare advice.\n\n` +
      `Here are the products currently available in our store:\n\n` +
      `${productList}\n\n` +
      `Based on the customer's skin type (${skinType}), please:\n` +
      `1. Recommend a simple daily skincare routine (morning and evening).\n` +
      `2. Choose 3-5 products from our available catalog that are most suitable for this skin type.\n` +
      `3. Explain WHY each product is recommended and how to use it.\n` +
      `4. Keep the tone friendly, warm, and professional.\n` +
      `5. Format the response clearly with sections and emojis for better readability.\n\n` +
      `If the customer's skin type is "Not specified", provide general skincare tips that work for most skin types and recommend versatile products.`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      this.logger.log(
        `Generated skincare advice for skin type: ${skinType} (${allProducts.length} products considered)`,
      );

      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Gemini API error: ${msg}`);
      throw new Error('Failed to generate skincare advice. Please try again later.');
    }
  }
}
