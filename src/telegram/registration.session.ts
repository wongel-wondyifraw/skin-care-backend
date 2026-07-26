/**
 * Lightweight in-memory session store for the multi-step registration flow.
 * Keyed by Telegram chatId (string). Each entry tracks which step the user
 * is currently on and the data they have provided so far.
 *
 * Note: this lives in process memory. On a single-instance deployment (Render
 * free tier) this is fine. If you ever scale to multiple instances, swap this
 * out for a Redis-backed store.
 */

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
