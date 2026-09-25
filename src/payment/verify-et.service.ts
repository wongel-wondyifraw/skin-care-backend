import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service.js';

export interface VerifyEtRequest {
  paymentMethod: 'bank' | 'telebirr';
  referenceCode: string; // The customer's transaction ID (never a URL)
  expectedAmount: number; // The 50% advance amount
}

export type VerifyEtOutcome =
  | 'verified' // ✅ All checks pass
  | 'failed' // ❌ Transaction not found or verification failed
  | 'amount_mismatch' // ❌ Amount paid < expected advance
  | 'receiver_mismatch' // ❌ Money didn't reach our account
  | 'duplicate' // ❌ Transaction already used for another order
  | 'queued' // ⏳ Bank still processing after poll timeout
  | 'unsupported' // ⚠️ Bank not supported
  | 'skipped'; // ⚠️ No API key configured

export interface VerifyEtResult {
  outcome: VerifyEtOutcome;
  requestId?: string;
  amount?: number;
  senderName?: string;
  receiverMatched?: boolean;
  isFirstUse?: boolean;
  rawResponse?: Record<string, unknown>;
  failureReason?: string;
}

const SYNC_WAIT_MS = 8_000;
/** Short poll only when no webhook is configured */
const POLL_MAX_ATTEMPTS_INLINE = 4;
const POLL_MAX_ATTEMPTS_BACKGROUND = 40;
const POLL_DEFAULT_INTERVAL_MS = 1_500;

@Injectable()
export class VerifyEtService {
  private readonly logger = new Logger(VerifyEtService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly webhookUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
  ) {
    this.apiKey = this.configService.get<string>('VERIFY_ET_API_KEY', '');
    this.baseUrl = this.configService.get<string>(
      'VERIFY_ET_BASE_URL',
      'https://verify.et',
    );
    const explicit = (
      this.configService.get<string>('VERIFY_ET_WEBHOOK_URL') || ''
    ).trim();
    const publicBase = (
      this.configService.get<string>('TELEGRAM_WEBHOOK_URL') || ''
    )
      .trim()
      .replace(/\/+$/, '');
    this.webhookUrl =
      explicit ||
      (publicBase ? `${publicBase}/api/webhooks/verify-et` : '');
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 10);
  }

  /**
   * Verify a payment transaction.
   * Waits synchronously, then polls if queued. Never throws on verify failures.
   */
  async verify(request: VerifyEtRequest): Promise<VerifyEtResult> {
    if (!this.isEnabled()) {
      this.logger.warn(
        'Verify.ET API key not configured — refusing auto-verification',
      );
      return {
        outcome: 'failed',
        failureReason:
          'Payment verification is not configured. Please contact support.',
      };
    }

    const ref = request.referenceCode.trim();
    if (!ref || /^https?:\/\//i.test(ref)) {
      return {
        outcome: 'failed',
        failureReason:
          'A valid transaction reference is required (not a screenshot URL).',
      };
    }

    const paymentInfo = await this.settingsService.getPaymentInfo();
    const body = this.buildPayload({ ...request, referenceCode: ref }, paymentInfo);
    if (!body) {
      return {
        outcome: 'unsupported',
        failureReason: 'Unsupported payment method',
      };
    }

    if (this.webhookUrl) {
      body.webhookUrl = this.webhookUrl;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      };
      if (this.webhookUrl) {
        headers['X-Webhook-Url'] = this.webhookUrl;
      }

      const res = await fetch(
        `${this.baseUrl}/api/verify?waitMs=${SYNC_WAIT_MS}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
      );

      const json = (await res.json()) as Record<string, unknown>;
      const requestId =
        typeof json.requestId === 'string' ? json.requestId : undefined;

      // 202 Queued — return fast when webhook can finish later; else short poll
      if (res.status === 202) {
        this.logger.log(
          `Verify.ET queued: requestId=${requestId ?? 'unknown'}`,
        );
        if (!requestId) {
          return {
            outcome: 'queued',
            rawResponse: json,
            failureReason:
              'Verification queued but no requestId returned. Please try again.',
          };
        }

        if (this.webhookUrl) {
          // Checkout returns immediately; webhook + background poll finish it
          return {
            outcome: 'queued',
            requestId,
            rawResponse: json,
            failureReason:
              'Payment is being verified with the bank. This usually takes a few seconds.',
          };
        }

        return this.pollUntilDone(
          requestId,
          request.expectedAmount,
          json,
          POLL_MAX_ATTEMPTS_INLINE,
        );
      }

      if (!res.ok) {
        this.logger.warn(
          `Verify.ET error ${res.status}: ${String(json.message)}`,
        );
        return {
          outcome: 'failed',
          requestId,
          rawResponse: json,
          failureReason: (json.message as string) || `HTTP ${res.status}`,
        };
      }

      // 200 OK — completed inline
      return this.parseCompletedResponse(json, request.expectedAmount);
    } catch (err) {
      this.logger.error('Verify.ET network error', err);
      return {
        outcome: 'failed',
        failureReason:
          'Could not reach the payment verification service. Please try again.',
      };
    }
  }

  /** Poll GET /api/verify/:requestId until completed/failed or attempts exhausted */
  async pollUntilDone(
    requestId: string,
    expectedAmount: number,
    initialRaw?: Record<string, unknown>,
    maxAttempts: number = POLL_MAX_ATTEMPTS_BACKGROUND,
  ): Promise<VerifyEtResult> {
    let pollAfterMs = POLL_DEFAULT_INTERVAL_MS;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.sleep(pollAfterMs);

      try {
        const res = await fetch(`${this.baseUrl}/api/verify/${requestId}`, {
          headers: { 'x-api-key': this.apiKey },
        });
        const json = (await res.json()) as Record<string, unknown>;

        const links = json.links as Record<string, unknown> | undefined;
        if (typeof links?.pollAfterMs === 'number' && links.pollAfterMs > 0) {
          pollAfterMs = Math.min(Number(links.pollAfterMs), 5_000);
        }

        const data = this.unwrapData(json);
        const processingStatus = String(
          data?.processingStatus ??
            (json.verification as Record<string, unknown> | undefined)
              ?.processingStatus ??
            '',
        ).toLowerCase();

        if (processingStatus === 'failed') {
          return {
            outcome: 'failed',
            requestId,
            rawResponse: json,
            failureReason:
              (json.message as string) || 'Verification failed at the bank',
          };
        }

        if (processingStatus === 'completed' || data?.verified === true) {
          const envelope = Array.isArray(json.data)
            ? json
            : { ...json, data: data ? [data] : [], requestId };
          return this.parseCompletedResponse(envelope, expectedAmount);
        }
      } catch (err) {
        this.logger.warn(`Verify.ET poll attempt ${attempt + 1} failed: ${err}`);
      }
    }

    return {
      outcome: 'queued',
      requestId,
      rawResponse: initialRaw,
      failureReason:
        'Bank verification is taking longer than expected. Please try again in a minute.',
    };
  }

  parseCompletedResponse(
    json: Record<string, unknown>,
    expectedAmount: number,
  ): VerifyEtResult {
    const data = this.unwrapData(json);
    if (!data) {
      return {
        outcome: 'failed',
        rawResponse: json,
        failureReason: 'Empty verification data',
      };
    }

    const verified = Boolean(data.verified);
    const amount = Number(data.amount) || 0;
    const senderName = String(data.senderName || '');
    const settlement = data.settlementAccountMatch as
      | Record<string, unknown>
      | undefined;
    const receiverMatched = settlement?.matched === true;
    const confirmation = data.confirmationHistory as
      | Record<string, unknown>
      | undefined;
    const isFirstUse = confirmation?.isFirstConfirmation !== false;
    const requestId = typeof json.requestId === 'string' ? json.requestId : '';

    const base: Omit<VerifyEtResult, 'outcome'> = {
      requestId,
      amount,
      senderName,
      receiverMatched,
      isFirstUse,
      rawResponse: json,
    };

    if (!verified) {
      return {
        ...base,
        outcome: 'failed',
        failureReason: 'Transaction not verified by bank',
      };
    }

    if (settlement && !receiverMatched) {
      const reason =
        typeof settlement.reason === 'string'
          ? settlement.reason
          : 'receiver_mismatch';
      return { ...base, outcome: 'receiver_mismatch', failureReason: reason };
    }

    if (confirmation && !isFirstUse) {
      const count = Number(confirmation.confirmationCount || 0);
      return {
        ...base,
        outcome: 'duplicate',
        failureReason: `Receipt already used ${count} time(s) before`,
      };
    }

    if (amount > 0 && amount < expectedAmount - 1) {
      return {
        ...base,
        outcome: 'amount_mismatch',
        failureReason: `Paid ${amount} ETB but expected ≥ ${expectedAmount} ETB`,
      };
    }

    return { ...base, outcome: 'verified' };
  }

  private unwrapData(
    json: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (Array.isArray(json.data)) {
      return (json.data[0] as Record<string, unknown>) ?? null;
    }
    if (json.data && typeof json.data === 'object') {
      return json.data as Record<string, unknown>;
    }
    return null;
  }

  private buildPayload(
    request: VerifyEtRequest,
    paymentInfo: {
      bankAccount: { accountNumber: string };
      telebirr: { phoneNumber: string };
    },
  ): Record<string, string> | null {
    const ref = request.referenceCode.trim();

    if (request.paymentMethod === 'bank') {
      const fullAccount = paymentInfo.bankAccount.accountNumber.replace(
        /\D/g,
        '',
      );
      const accountSuffix = fullAccount.slice(-8);
      return {
        bank: 'cbe',
        referenceNumber: ref,
        accountSuffix,
        settlementAccount: fullAccount,
      };
    }

    if (request.paymentMethod === 'telebirr') {
      const phone = paymentInfo.telebirr.phoneNumber.replace(/\D/g, '');
      return {
        bank: 'telebirr',
        transactionNumber: ref,
        settlementAccount: phone,
      };
    }

    return null;
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private authHeaders() {
    return { 'x-api-key': this.apiKey };
  }

  /** Live status + result payload for one verification request */
  async getVerificationDetail(requestId: string): Promise<Record<string, unknown> | null> {
    if (!this.isEnabled() || !requestId) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/verify/${requestId}`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) {
        this.logger.warn(
          `Verify.ET detail ${requestId} → HTTP ${res.status}`,
        );
        return null;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      this.logger.error(`Verify.ET detail fetch failed: ${err}`);
      return null;
    }
  }

  async getHistory(limit = 40, offset = 0) {
    if (!this.isEnabled()) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/api/verify/history?limit=${limit}&offset=${offset}`,
        { headers: this.authHeaders() },
      );
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async getDashboardData() {
    if (!this.isEnabled()) return null;
    const headers = this.authHeaders();

    const [uptime, metrics, overview, balance, history] = await Promise.all([
      fetch(`${this.baseUrl}/api/uptime`, { headers })
        .then((r) => r.json())
        .catch(() => null),
      fetch(`${this.baseUrl}/api/metrics`, { headers })
        .then((r) => r.json())
        .catch(() => null),
      fetch(`${this.baseUrl}/api/reports/verification/overview`, { headers })
        .then((r) => r.json())
        .catch(() => null),
      fetch(`${this.baseUrl}/api/credits/balance`, { headers })
        .then((r) => r.json())
        .catch(() => null),
      this.getHistory(40, 0),
    ]);

    return { uptime, metrics, overview, balance, history };
  }
}
