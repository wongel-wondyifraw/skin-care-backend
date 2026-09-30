import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Groq vision via OpenAI-compatible chat completions.
 * Face-scan fallback only when Gemini is unavailable (503/429/etc).
 * Get a key at https://console.groq.com → API Keys (gsk_…).
 */
@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl = 'https://api.groq.com/openai/v1';

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('GROQ_API_KEY', '').trim();
    this.model =
      this.config.get<string>('GROQ_MODEL')?.trim() ||
      'meta-llama/llama-4-scout-17b-16e-instruct';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generateVisionText(input: {
    prompt: string;
    imageBuffer: Buffer;
    mimeType: string;
    jsonMode?: boolean;
  }): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GROQ_API_KEY is not configured');
    }

    const mime = input.mimeType || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${input.imageBuffer.toString('base64')}`;

    const body: Record<string, unknown> = {
      model: this.model,
      temperature: input.jsonMode ? 0.1 : 0.3,
      max_completion_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
    };

    if (input.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `Groq API ${res.status}: ${errText.slice(0, 240) || res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('Groq returned an empty response');
    }
    this.logger.log(`Groq vision ok (model=${this.model})`);
    return String(text);
  }
}
