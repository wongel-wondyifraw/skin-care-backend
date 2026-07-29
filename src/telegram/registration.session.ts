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
  | 'awaiting_username'
  | 'awaiting_phone'
  | 'awaiting_skin_type'
  | 'awaiting_address'
  | 'complete';

export interface RegistrationSession {
  step: RegistrationStep;
  fullName?: string;
  telegramUsername?: string | null;
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

// ─── Profile Edit ──────────────────────────────────────────────────────────

export type ProfileEditStep =
  | 'choosing_field'      // user is choosing what to edit
  | 'awaiting_name'       // editing full name
  | 'awaiting_phone'      // editing phone
  | 'awaiting_skin_type'  // editing skin type
  | 'awaiting_address';   // editing address

export interface ProfileEditSession {
  step: ProfileEditStep;
  customerId: string;       // DB id of the customer being edited
  field?: 'name' | 'phone' | 'skinType' | 'address';
  newValue?: string;
}

export class ProfileEditSessionStore {
  private readonly sessions = new Map<string, ProfileEditSession>();

  get(chatId: string): ProfileEditSession | undefined {
    return this.sessions.get(chatId);
  }

  set(chatId: string, session: ProfileEditSession): void {
    this.sessions.set(chatId, session);
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }
}

// ─── Order (quantity → optional delivery address) ──────────────────────────

export type OrderSessionStep =
  | 'awaiting_quantity'
  | 'awaiting_delivery_address';

export interface OrderSession {
  step: OrderSessionStep;
  productId: string;
  customerId: string;
  /** Unit price */
  cost: number;
  productName: string;
  maxStock: number;
  quantity?: number;
}

export class OrderSessionStore {
  private readonly sessions = new Map<string, OrderSession>();

  get(chatId: string): OrderSession | undefined {
    return this.sessions.get(chatId);
  }

  set(chatId: string, session: OrderSession): void {
    this.sessions.set(chatId, session);
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }
}
