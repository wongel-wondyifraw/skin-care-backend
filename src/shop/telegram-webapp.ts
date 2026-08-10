import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

export type TelegramWebAppUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

/**
 * Validates Telegram Mini App initData per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramWebAppInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86_400,
): { user: TelegramWebAppUser; authDate: number } {
  if (!initData?.trim()) {
    throw new BadRequestException('initData is required');
  }
  if (!botToken) {
    throw new UnauthorizedException('Bot token is not configured');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    throw new UnauthorizedException('Missing initData hash');
  }

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedException('Invalid Telegram initData');
  }

  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate)) {
    throw new UnauthorizedException('Invalid auth_date');
  }
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > maxAgeSeconds || age < -60) {
    throw new UnauthorizedException('Telegram initData expired');
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    throw new UnauthorizedException('Telegram user missing from initData');
  }

  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userRaw) as TelegramWebAppUser;
  } catch {
    throw new UnauthorizedException('Invalid Telegram user payload');
  }

  if (!user?.id || !Number.isFinite(Number(user.id))) {
    throw new UnauthorizedException('Invalid Telegram user id');
  }

  return { user: { ...user, id: Number(user.id) }, authDate };
}

export function customerInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
