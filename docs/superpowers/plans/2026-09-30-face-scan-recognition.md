# Face Scan Image Recognition Improvement Plan

> Applied 2026-09-30. Groq (not Grok/xAI) for face-scan failover.

**Goal:** Accept most real-world face photos; survive Gemini afternoon 503s via Groq vision.

**Architecture:** Local preflight → Gemini gate/analysis (retry → optional fallback model → **Groq**) → typed Telegram replies. Receipt OCR stays Gemini-only.

## Env

```
GROQ_API_KEY=          # https://console.groq.com → API Keys (gsk_…)
GROQ_MODEL=qwen/qwen3.8-27b
GEMINI_FALLBACK_MODEL=gemini-2.0-flash
```

Do not commit real keys. Rotate any key that was pasted in chat.

## Key files

- `src/telegram/groq.service.ts`
- `src/telegram/gemini.service.ts` (`visionTextWithFallback`)
- `src/telegram/telegram.update.ts` (Back-before-photo)
- `src/order/order.service.ts` (receipt unavailable copy)
