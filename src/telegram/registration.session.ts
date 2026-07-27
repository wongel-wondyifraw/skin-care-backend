/**
 * Unified in-memory session store.
 *
 * Two independent session types live here:
 *   - RegistrationSession  — multi-step user onboarding flow
 *   - AdminSession         — admin mode (authenticated via password)
 *
 * Keyed by Telegram chatId (string).
 * Single-instance deployment (Render free tier) is fine with an in-memory Map.
 * Swap for Redis if you ever go multi-instance.
 */

// ─── Registration ──────────────────────────────────────────────────────────

export type RegistrationStep =
  | 'awaiting_name'
  | 'awaiting_phone'
  | 'awaiting_skin_type'
  | 'awaiting_address'
  | 'complete';

export interface RegistrationSession {
  step: RegistrationStep;
  fullName?: string;
  phone?: string;
  skinTypeId?: string | null;
  address?: string;
}

export class RegistrationSessionStore {
  private readonly sessions = new Map<string, RegistrationSession>();

  get(chatId: string): RegistrationSession | undefined {
    return this.sessions.get(chatId);
  }

  set(chatId: string, session: RegistrationSession): void {
    this.sessions.set(chatId, session);
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }
}

// ─── Admin ─────────────────────────────────────────────────────────────────

export type AdminStep =
  | 'awaiting_password' // /admin entered, waiting for password
  | 'authenticated';    // password accepted, admin menu is active

export interface AdminSession {
  step: AdminStep;
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSession>();

  get(chatId: string): AdminSession | undefined {
    return this.sessions.get(chatId);
  }

  set(chatId: string, session: AdminSession): void {
    this.sessions.set(chatId, session);
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  isAuthenticated(chatId: string): boolean {
    return this.sessions.get(chatId)?.step === 'authenticated';
  }
}
