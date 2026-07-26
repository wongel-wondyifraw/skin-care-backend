import { Logger } from '@nestjs/common';
import { Ctx, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { Message } from 'telegraf/types';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { CustomerService } from '../customer/customer.service.js';
import {
  RegistrationSession,
  RegistrationSessionStore,
} from './registration.session.js';

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);
  private readonly sessions = new RegistrationSessionStore();

  constructor(
    private readonly skinTypeService: SkinTypeService,
    private readonly customerService: CustomerService,
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

    // Check if user already completed registration
    const existing = await this.customerService.findByTelegramId(telegramId);
    if (existing) {
      await ctx.reply(
        `Welcome back, ${existing.fullName}! 👋\n\n` +
          `You are already registered with Medaf Skin Care. 🌿\n` +
          `We will keep you updated on new arrivals and offers!`,
      );
      return;
    }

    // Start a fresh registration session
    this.sessions.set(chatId, { step: 'awaiting_name' });

    await ctx.reply(
      `👋 Welcome to Medaf Skin Care, ${firstName}! 🌿✨\n\n` +
        `We offer premium skincare products tailored for every skin type.\n\n` +
        `Let's get you registered — it only takes a moment.\n\n` +
        `What is your full name?`,
    );
  }

  // ─────────────────────────────────────────────
  // All text / contact messages go through here
  // ─────────────────────────────────────────────
  @On('message')
  async onMessage(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const session = this.sessions.get(chatId);

    // No active registration session — ignore
    if (!session) return;

    const message = ctx.message as Message.TextMessage & Message.ContactMessage;

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
  // Step handlers
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
    // Accept either a shared contact or a typed number
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

    // Load skin types from DB and present as a keyboard
    const skinTypes = await this.skinTypeService.findAll();

    if (skinTypes.length === 0) {
      // No skin types seeded yet — skip and store null
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

    // Accept whatever they typed — store null if no match
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

    // Save to the customers table
    try {
      await this.customerService.create({
        telegramId: ctx.from!.id,
        fullName: session.fullName!,
        phone: session.phone!,
        address: session.address,
        skinTypeId: session.skinTypeId ?? null,
      });

      // Clean up the session
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

      // Reset session so they can start over
      this.sessions.delete(chatId);
    }
  }
}
