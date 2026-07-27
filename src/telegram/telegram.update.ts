import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Command, Ctx, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { Message } from 'telegraf/types';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { CustomerService } from '../customer/customer.service.js';
import {
  AdminSessionStore,
  RegistrationSession,
  RegistrationSessionStore,
} from './registration.session.js';

// ─── Persistent admin keyboard shown at the bottom of the chat ──────────────
const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: '📦 Products' }, { text: '👥 Customers' }],
    [{ text: '🛒 Orders' }, { text: '⚙️ Settings' }],
    [{ text: '🚪 Logout' }],
  ],
  resize_keyboard: true,
  // NOT one_time_keyboard — stays visible (sticky) until logout
};

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);
  private readonly sessions = new RegistrationSessionStore();
  private readonly adminSessions = new AdminSessionStore();

  constructor(
    private readonly skinTypeService: SkinTypeService,
    private readonly customerService: CustomerService,
    private readonly config: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // /start
  // ─────────────────────────────────────────────
  @Start()
  async onStart(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const telegramId = ctx.from!.id;
    const firstName = ctx.from?.first_name ?? 'there';

    this.logger.log(`/start from chatId=${chatId}`);

    // If admin session is active, show admin menu instead
    if (this.adminSessions.isAuthenticated(chatId)) {
      await this.sendAdminMenu(ctx, 'You are already in admin mode.');
      return;
    }

    const existing = await this.customerService.findByTelegramId(telegramId);
    if (existing) {
      await ctx.reply(
        `Welcome back, ${existing.fullName}! 👋\n\n` +
          `You are already registered with Medaf Skin Care. 🌿\n` +
          `We will keep you updated on new arrivals and offers!`,
      );
      return;
    }

    this.sessions.set(chatId, { step: 'awaiting_name' });

    await ctx.reply(
      `👋 Welcome to Medaf Skin Care, ${firstName}! 🌿✨\n\n` +
        `We offer premium skincare products tailored for every skin type.\n\n` +
        `Let's get you registered — it only takes a moment.\n\n` +
        `What is your full name?`,
    );
  }

  // ─────────────────────────────────────────────
  // /admin — enter admin mode
  // ─────────────────────────────────────────────
  @Command('admin')
  async onAdminCommand(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);

    // Already authenticated — just show the menu
    if (this.adminSessions.isAuthenticated(chatId)) {
      await this.sendAdminMenu(ctx, 'You are already in admin mode.');
      return;
    }

    // Clear any in-progress registration so the password answer
    // is not accidentally processed as a registration step
    this.sessions.delete(chatId);

    this.adminSessions.set(chatId, { step: 'awaiting_password' });

    await ctx.reply(
      `🔐 Admin access requested.\n\nPlease enter the admin password:`,
      { reply_markup: { remove_keyboard: true } },
    );
  }

  // ─────────────────────────────────────────────
  // All text / contact messages
  // ─────────────────────────────────────────────
  @On('message')
  async onMessage(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const message = ctx.message as Message.TextMessage & Message.ContactMessage;
    const text = ('text' in message ? message.text : '').trim();

    // ── Admin password verification ──────────────────────────────
    const adminSession = this.adminSessions.get(chatId);
    if (adminSession?.step === 'awaiting_password') {
      await this.handleAdminPassword(ctx, chatId, text);
      return;
    }

    // ── Admin menu button presses ────────────────────────────────
    if (this.adminSessions.isAuthenticated(chatId)) {
      await this.handleAdminMenuAction(ctx, chatId, text);
      return;
    }

    // ── Registration flow ────────────────────────────────────────
    const session = this.sessions.get(chatId);
    if (!session) return;

    switch (session.step) {
      case 'awaiting_name':
        await this.handleName(ctx, chatId, session, message);
        break;
      case 'awaiting_phone':
        await this.handlePhone(ctx, chatId, session, message);
        break;
      case 'awaiting_skin_type':
        await this.handleSkinType(ctx, chatId, session, message);
        break;
      case 'awaiting_address':
        await this.handleAddress(ctx, chatId, session, message);
        break;
      default:
        break;
    }
  }

  // ─────────────────────────────────────────────
  // Admin helpers
  // ─────────────────────────────────────────────

  private async handleAdminPassword(
    ctx: Context,
    chatId: string,
    input: string,
  ) {
    const correctPassword = this.config.get<string>('TELEGRAM_ADMIN_PASSWORD');

    if (input !== correctPassword) {
      await ctx.reply(
        `❌ Incorrect password. Try again or send /admin to start over.`,
      );
      // Keep the session alive so they can retry without re-sending /admin
      return;
    }

    // Authenticated
    this.adminSessions.set(chatId, { step: 'authenticated' });
    this.logger.log(`Admin authenticated for chatId=${chatId}`);
    await this.sendAdminMenu(ctx, `✅ Access granted. Welcome, Admin!`);
  }

  private async sendAdminMenu(ctx: Context, headerText: string) {
    await ctx.reply(
      `${headerText}\n\n` +
        `Use the buttons below to manage your store:`,
      { reply_markup: ADMIN_KEYBOARD },
    );
  }

  private async handleAdminMenuAction(
    ctx: Context,
    chatId: string,
    text: string,
  ) {
    switch (text) {
      case '📦 Products':
        await ctx.reply(
          `📦 Products\n\nManage your product catalogue via the web admin panel:\n` +
            `https://skin-care-frontend-ecru.vercel.app/admin/products`,
          { reply_markup: ADMIN_KEYBOARD },
        );
        break;

      case '👥 Customers':
        await this.handleCustomersAction(ctx);
        break;

      case '🛒 Orders':
        await ctx.reply(
          `🛒 Orders\n\nOrder management is coming soon. Stay tuned!`,
          { reply_markup: ADMIN_KEYBOARD },
        );
        break;

      case '⚙️ Settings':
        await ctx.reply(
          `⚙️ Settings\n\nManage your store settings via the web admin panel:\n` +
            `https://skin-care-frontend-ecru.vercel.app/admin/settings`,
          { reply_markup: ADMIN_KEYBOARD },
        );
        break;

      case '🚪 Logout':
        this.adminSessions.delete(chatId);
        await ctx.reply(
          `👋 You have been logged out of admin mode.`,
          { reply_markup: { remove_keyboard: true } },
        );
        break;

      default:
        // Unrecognised text while in admin mode — remind them of the menu
        await this.sendAdminMenu(ctx, `Use the buttons below:`);
        break;
    }
  }

  private async handleCustomersAction(ctx: Context) {
    const customers = await this.customerService.findAll();

    if (customers.length === 0) {
      await ctx.reply(`👥 No registered customers yet.`, {
        reply_markup: ADMIN_KEYBOARD,
      });
      return;
    }

    const summary = customers
      .slice(0, 20) // cap at 20 to avoid hitting Telegram's message length limit
      .map(
        (c, i) =>
          `${i + 1}. ${c.fullName} — ${c.phone}`,
      )
      .join('\n');

    const total = customers.length;
    const note = total > 20 ? `\n\n...and ${total - 20} more.` : '';

    await ctx.reply(
      `👥 Registered Customers (${total} total)\n\n${summary}${note}`,
      { reply_markup: ADMIN_KEYBOARD },
    );
  }

  // ─────────────────────────────────────────────
  // Registration step handlers
  // ─────────────────────────────────────────────

  private async handleName(
    ctx: Context,
    chatId: string,
    session: RegistrationSession,
    message: Message.TextMessage,
  ) {
    const name = message.text?.trim();
    if (!name || name.length < 2) {
      await ctx.reply(
        'Please enter your full name (at least 2 characters). | ሙሉ ስሞን ያስገቡ',
      );
      return;
    }

    session.fullName = name;
    session.step = 'awaiting_phone';
    this.sessions.set(chatId, session);

    await ctx.reply(
      `Great, ${name}! 👍\n\nNow please share your phone number | ስልኮን ያጋሩን.\n` +
        `You can tap the button below or type it manually.`,
      {
        reply_markup: {
          keyboard: [
            [{ text: '📱 Share my phone number | ያጋሩ', request_contact: true }],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
  }

  private async handlePhone(
    ctx: Context,
    chatId: string,
    session: RegistrationSession,
    message: Message.TextMessage & Message.ContactMessage,
  ) {
    let phone: string | undefined;

    if ('contact' in message && message.contact?.phone_number) {
      phone = message.contact.phone_number;
    } else if ('text' in message && message.text) {
      phone = message.text.trim();
    }

    if (!phone || phone.length < 7) {
      await ctx.reply(
        'Please share a valid phone number. | ያስገቡት ቁጥር ትክክል አይደለም በድጋሚ ይሞክሩ',
      );
      return;
    }

    session.phone = phone;
    session.step = 'awaiting_skin_type';
    this.sessions.set(chatId, session);

    const skinTypes = await this.skinTypeService.findAll();

    if (skinTypes.length === 0) {
      session.skinTypeId = null;
      session.step = 'awaiting_address';
      this.sessions.set(chatId, session);

      await ctx.reply(`Got it! 📞\n\nFinally, what is your delivery address?`, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }

    const keyboard = skinTypes.map((st) => [{ text: st.name }]);

    await ctx.reply(
      `Perfect! 📞\n\nWhat is your skin type? Choose from the options below:`,
      {
        reply_markup: {
          keyboard,
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
  }

  private async handleSkinType(
    ctx: Context,
    chatId: string,
    session: RegistrationSession,
    message: Message.TextMessage,
  ) {
    const input = message.text?.trim();
    if (!input) {
      await ctx.reply('Please select your skin type from the options.');
      return;
    }

    const skinTypes = await this.skinTypeService.findAll();
    const match = skinTypes.find(
      (st) => st.name.toLowerCase() === input.toLowerCase(),
    );

    session.skinTypeId = match?.id ?? null;
    session.step = 'awaiting_address';
    this.sessions.set(chatId, session);

    await ctx.reply(
      `Got it — ${match ? match.name : input} skin! 🌿\n\n` +
        `Almost done! What is your delivery address?`,
      { reply_markup: { remove_keyboard: true } },
    );
  }

  private async handleAddress(
    ctx: Context,
    chatId: string,
    session: RegistrationSession,
    message: Message.TextMessage,
  ) {
    const address = message.text?.trim();
    if (!address || address.length < 5) {
      await ctx.reply('Please enter a valid address (at least 5 characters).');
      return;
    }

    session.address = address;
    session.step = 'complete';
    this.sessions.set(chatId, session);

    try {
      await this.customerService.create({
        telegramId: ctx.from!.id,
        fullName: session.fullName!,
        phone: session.phone!,
        address: session.address,
        skinTypeId: session.skinTypeId ?? null,
      });

      this.sessions.delete(chatId);

      await ctx.reply(
        `You are all set, ${session.fullName}! 🎉\n\n` +
          `Here is a summary of your registration:\n\n` +
          `👤 Name: ${session.fullName}\n` +
          `📞 Phone: ${session.phone}\n` +
          `🌿 Skin type: ${session.skinTypeId ? 'Saved' : 'Not specified'}\n` +
          `📍 Address: ${address}\n\n` +
          `Welcome to the Medaf Skin Care family! We will keep you updated on ` +
          `new arrivals, offers, and skincare tips. 😊`,
        { reply_markup: { remove_keyboard: true } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to save customer chatId=${chatId}: ${msg}`);

      await ctx.reply(
        `Sorry, something went wrong while saving your details. ` +
          `Please try again by sending /start.`,
        { reply_markup: { remove_keyboard: true } },
      );

      this.sessions.delete(chatId);
    }
  }
}
