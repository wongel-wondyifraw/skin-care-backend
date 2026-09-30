# Face Scan Image Recognition Improvement Plan

> Applied 2026-09-30. Use this as the reference for the shipped design.

**Goal:** Accept most real-world face photos; reply specifically for no-face / extreme dark; never blame the photo for infra failures.

**Architecture:** Local preflight (sharp) → Gemini JSON gate → Gemini analysis → typed Telegram replies. Catalog trimmed to 40 in-stock items.

## Phases shipped

- [x] Typed reject codes (`no_face`, `too_dark`, …) + infra kinds
- [x] Local brightness / empty preflight + image downscale
- [x] Two-step Gemini (gate JSON + analysis)
- [x] Honest catch messages + Cloudinary/save soft-fail
- [x] One Gemini retry on transient errors
- [x] Unit tests (`face-scan.spec.ts`)

## Key files

- `src/telegram/face-scan.types.ts`
- `src/telegram/face-scan-messages.ts`
- `src/telegram/face-scan-preflight.ts`
- `src/telegram/gemini.service.ts`
- `src/telegram/telegram.update.ts` (`handleScanPhoto`)
- `src/telegram/face-scan.spec.ts`
