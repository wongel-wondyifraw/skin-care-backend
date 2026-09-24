import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service.js';

export interface VerifyEtRequest {
  paymentMethod: 'bank' | 'telebirr';
  referenceCode: string; // The customer's transaction ID
  expectedAmount: number; // The 50% advance amount
}

export type VerifyEtOutcome =
  | 'verified' // ✅ All checks pass
  | 'failed' // ❌ Transaction not found or verification failed
  | 'amount_mismatch' // ❌ Amount paid < expected advance
  | 'receiver_mismatch' // ❌ Money didn't reach our account
  | 'duplicate' // ❌ Transaction already used for another order
  | 'queued' // ⏳ Bank is slow, webhook will follow
  | 'unsupported' // ⚠️ Bank not supported
  | 'skipped'; // ⚠️ No API key configured, skip auto-verify

export interface VerifyEtResult {
  outcome: VerifyEtOutcome;
  requestId?: string; // Verify.ET requestId (for webhook correlation)
  amount?: number; // Verified transaction amount
  senderName?: string; // Who sent the money
  receiverMatched?: boolean; // Did money reach our account?
  isFirstUse?: boolean; // Is this the first time this receipt is used?
  rawResponse?: Record<string, unknown>;
  failureReason?: string; // Human-readable reason for failure
}

@Injectable()
export class VerifyEtService {
  private readonly logger = new Logger(VerifyEtService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
  ) {
    this.apiKey = this.configService.get<string>('VERIFY_ET_API_KEY', '');
    this.baseUrl = this.configService.get<string>(
      'VERIFY_ET_BASE_URL',
      'https://verify.et',
    );
  }

  /** Check if Verify.ET integration is configured */
  isEnabled(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 10);
  }

  /**
   * Verify a payment transaction.
   * Returns a structured result — never throws on verification failures.
   */
  async verify(request: VerifyEtRequest): Promise<VerifyEtResult> {
    if (!this.isEnabled()) {
      this.logger.warn(
        'Verify.ET API key not configured — skipping auto-verification',
      );
      return { outcome: 'skipped' };
    }

    // 1. Build the bank-specific payload using our stored settlement accounts
    const paymentInfo = await this.settingsService.getPaymentInfo();
    const body = this.buildPayload(request, paymentInfo);
    if (!body) {
      return {
        outcome: 'unsupported',
        failureReason: 'Unsupported payment method',
      };
    }

    // 2. Call Verify.ET with a 5-second sync wait
    try {
      const res = await fetch(`${this.baseUrl}/api/verify?waitMs=5000`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      });

      const json = (await res.json()) as Record<string, unknown>;

      // 202 Queued — bank is slow, webhook will follow
      if (res.status === 202) {
        this.logger.log(
          `Verify.ET queued: requestId=${String(json.requestId)}`,
        );
        return {
          outcome: 'queued',
          requestId: String(json.requestId),
          rawResponse: json,
        };
      }

      // Non-200 error
      if (!res.ok) {
        this.logger.warn(
          `Verify.ET error ${res.status}: ${String(json.message)}`,
        );
        return {
          outcome: 'failed',
          rawResponse: json,
          failureReason: (json.message as string) || `HTTP ${res.status}`,
        };
      }

      // 200 OK — parse the completed result
      return this.parseCompletedResponse(json, request.expectedAmount);
    } catch (err) {
      this.logger.error('Verify.ET network error', err);
      return {
        outcome: 'skipped',
        failureReason: 'Network error contacting Verify.ET',
      };
    }
  }

  /** Parse a completed webhook or sync response */
  parseCompletedResponse(
    json: Record<string, unknown>,
    expectedAmount: number,
  ): VerifyEtResult {
    const data = Array.isArray(json.data) ? json.data[0] : json.data;
    if (!data) {
      return {
        outcome: 'failed',
        rawResponse: json,
        failureReason: 'Empty data',
      };
    }

    const verified = Boolean(data.verified);
    const amount = Number(data.amount) || 0;
    const senderName = String(data.senderName || '');
    const settlement = data.settlementAccountMatch as
      Record<string, unknown> | undefined;
    const receiverMatched = settlement?.matched === true;
    const confirmation = data.confirmationHistory as
      Record<string, unknown> | undefined;
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

    // Check 1: Was the transaction valid at all?
    if (!verified) {
      return {
        ...base,
        outcome: 'failed',
        failureReason: 'Transaction not verified by bank',
      };
    }

    // Check 2: Did the money arrive in OUR account?
    if (settlement && !receiverMatched) {
      const reason =
        typeof settlement.reason === 'string'
          ? settlement.reason
          : 'receiver_mismatch';
      return { ...base, outcome: 'receiver_mismatch', failureReason: reason };
    }

    // Check 3: Is this a duplicate / replay?
    if (confirmation && !isFirstUse) {
      const count = Number(confirmation.confirmationCount || 0);
      return {
        ...base,
        outcome: 'duplicate',
        failureReason: `Receipt already used ${count} time(s) before`,
      };
    }

    // Check 4: Did they pay enough? (allow 1 ETB tolerance for rounding)
    if (amount > 0 && amount < expectedAmount - 1) {
      return {
        ...base,
        outcome: 'amount_mismatch',
        failureReason: `Paid ${amount} ETB but expected ≥ ${expectedAmount} ETB`,
      };
    }

    // All checks pass
    return { ...base, outcome: 'verified' };
  }

  /** Build the bank-specific Verify.ET request body */
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

  async getDashboardData() {
    if (!this.isEnabled()) return null;
    const headers = { 'x-api-key': this.apiKey };

    // Fetch from multiple Verify.ET endpoints in parallel
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
      fetch(`${this.baseUrl}/api/verify/history?limit=10`, { headers })
        .then((r) => r.json())
        .catch(() => null),
    ]);

    return { uptime, metrics, overview, balance, history };
  }
}
