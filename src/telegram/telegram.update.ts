import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Command, Ctx, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { Message } from 'telegraf/types';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { CustomerService } from '../customer/customer.service.js';
import { ProductService } from '../product/product.service.js';
import { GeminiService } from './gemini.service.js';
import {
  AdminSessionStore,
  ProfileEditSession,
  ProfileEditSessionStore,
  RegistrationSession,
  RegistrationSessionStore,
} from './registration.session.js';

// ─── Persistent admin keyboard shown at the bottom of the chat ──────────────
const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: '👤 Profile' }, { text: '💡 Get Advice' }],
    [{ text: '📦 Products' }, { text: '👥 Customers' }],
    [{ text: '🛒 Orders' }, { text: '⚙️ Settings' }],
    [{ text: '🚪 Logout' }],
  ],
  resize_keyboard: true,
};

// ─── User keyboard with profile button ───────────────────────────────────────
const USER_KEYBOARD = {
  keyboard: [[{ text: '👤 Profile' }, { text: '💡 Get Advice' }]],
  resize_keyboard: true,
};

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);
  private readonly sessions = new RegistrationSessionStore();
  private readonly adminSessions = new AdminSessionStore();
  private readonly profileEditSessions = new ProfileEditSessionStore();

  constructor(
    private readonly skinTypeService: SkinTypeService,
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly geminiService: GeminiService,
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
        { reply_markup: USER_KEYBOARD },
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
  // /profile — view & edit user profile
  // ─────────────────────────────────────────────
  @Command('profile')
  async onProfileCommand(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const telegramId = ctx.from!.id;

    // Clear any active flows so profile takes priority
    this.sessions.delete(chatId);

    const customer = await this.customerService.findByTelegramId(telegramId);
    if (!customer) {
      await ctx.reply(
        `You are not registered yet. Send /start to create your profile.`,
      );
      return;
    }

    await this.showProfileMenu(ctx, customer);
  }

  private async showProfileMenu(ctx: Context, customer: any) {
    const skinTypeName = customer.skinType?.name ?? 'Not specified';

    await ctx.reply(
      `👤 Your Profile\n\n` +
        `📝 Name: ${customer.fullName}\n` +
        `📞 Phone: ${customer.phone}\n` +
        `🌿 Skin type: ${skinTypeName}\n` +
        `📍 Address: ${customer.address}\n\n` +
        `To edit, choose a field:`,
      {
        reply_markup: {
          keyboard: [
            [{ text: '📝 Edit Name' }, { text: '📞 Edit Phone' }],
            [{ text: '🌿 Edit Skin Type' }, { text: '📍 Edit Address' }],
            [{ text: '❌ Cancel' }],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );

    // Start profile edit session
    this.profileEditSessions.set(String(ctx.chat!.id), {
      step: 'choosing_field',
      customerId: customer.id,
    });
  }

  private async handleGetAdvice(ctx: Context, chatId: string) {
    const telegramId = ctx.from!.id;

    const customer = await this.customerService.findByTelegramId(telegramId);
    if (!customer) {
      await ctx.reply(
        `Please complete your registration first by sending /start.`,
        { reply_markup: USER_KEYBOARD },
      );
      return;
    }

    await ctx.reply(
      `⏳ Analyzing your skin type and our product catalog...\n\nThis may take a few seconds.`,
      { reply_markup: USER_KEYBOARD },
    );

    try {
      const allProducts = await this.productService.findAll();

      if (allProducts.length === 0) {
        await ctx.reply(
          `Sorry, we don't have any products in our catalog yet. Please check back later!`,
          { reply_markup: USER_KEYBOARD },
        );
        return;
      }

      const userSkinType = customer.skinType?.name || null;

      // Filter: only products matching user's skin type or "All"
      let filteredProducts = allProducts;
      if (userSkinType && userSkinType.toLowerCase() !== 'all') {
        filteredProducts = allProducts.filter((p) => {
          const productSkinType = (p.skinType?.name || 'All').toLowerCase();
          return (
            productSkinType === userSkinType.toLowerCase() ||
            productSkinType === 'all'
          );
        });
      }

      if (filteredProducts.length === 0) {
        await ctx.reply(
          `😔 Unfortunately, we don't have any products specifically for ${userSkinType} skin type in our catalog yet.\n\n` +
            `Please check back later, or contact our support team for personalized recommendations!`,
          { reply_markup: USER_KEYBOARD },
        );
        return;
      }

      // All filtered products are out of stock
      const inStockProducts = filteredProducts.filter((p) => p.stock > 0);
      if (inStockProducts.length === 0) {
        const productNames = filteredProducts
          .slice(0, 5)
          .map((p) => `• ${p.name}`)
          .join('\n');
        await ctx.reply(
          `We have products for ${userSkinType || 'your'} skin type, but they are currently out of stock:\n\n` +
            `${productNames}\n\n` +
            `Please check back soon or contact us to pre-order!`,
          { reply_markup: USER_KEYBOARD },
        );
        return;
      }

      // ── Step 1: Get AI advice text ──────────────────────────────
      const { text: advice, mentionedProducts: recommendedProducts } =
        await this.geminiService.generateSkincareAdvice(
          userSkinType,
          filteredProducts,
        );

      // Send advice in chunks (Telegram 4096 char limit)
      const maxLength = 4000;
      if (advice.length <= maxLength) {
        await ctx.reply(advice);
      } else {
        const chunks: string[] = [];
        let remaining = advice;
        while (remaining.length > 0) {
          if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
          }
          let splitAt = remaining.lastIndexOf('\n', maxLength);
          if (splitAt === -1 || splitAt < maxLength / 2) splitAt = maxLength;
          chunks.push(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt).trim();
        }
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      }

      // ── Step 2: Extract which products were recommended ─────────
      // Already done inside generateSkincareAdvice — no second API call needed.

      if (recommendedProducts.length === 0) {
        await ctx.reply(
          `No specific products were matched. Browse our full catalog for more options!`,
          { reply_markup: USER_KEYBOARD },
        );
        return;
      }

      // ── Step 3: Send a photo card for each recommended product ──
      await ctx.reply(
        `🛍️ Here are the products recommended for you:`,
      );

      for (const product of recommendedProducts) {
        const price =
          product.price != null
            ? `${Number(product.price).toFixed(2)} ETB`
            : 'Price not set';
        const stockLine =
          product.stock > 0
            ? `✅ In stock (${product.stock} units)`
            : `❌ Out of stock`;
        const category = product.category?.name || 'Uncategorized';
        const skinTypeName = product.skinType?.name || 'All skin types';
        const description = product.description?.trim() || 'No description available.';

        const caption =
          `🌿 ${product.name}\n\n` +
          `📂 Category: ${category}\n` +
          `💧 Suitable for: ${skinTypeName} skin\n` +
          `💰 Price: ${price}\n` +
          `${stockLine}\n\n` +
          `📝 ${description}`;

        const inlineKeyboard = {
          inline_keyboard: [
            [
              {
                text: product.stock > 0 ? '🛒 Order Now' : '🔔 Notify Me',
                callback_data: `order_${product.id}`,
              },
            ],
          ],
        };

        try {
          // Send photo using the Cloudinary URL stored in product.image
          await ctx.replyWithPhoto(
            { url: product.image },
            {
              caption,
              reply_markup: inlineKeyboard,
            },
          );
        } catch {
          // Image URL might be broken — fall back to a text card
          this.logger.warn(
            `Failed to send photo for product ${product.name}, sending text card instead`,
          );
          await ctx.reply(caption, { reply_markup: inlineKeyboard });
        }
      }

      // Restore the sticky keyboard after all cards are sent
      await ctx.reply(`That's your personalized recommendation! 😊`, {
        reply_markup: USER_KEYBOARD,
      });

      this.logger.log(
        `Advice + ${recommendedProducts.length} product cards sent to ${customer.fullName} (skin type: ${userSkinType})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to generate advice for chatId=${chatId}: ${msg}`,
      );
      await ctx.reply(
        `Sorry, something went wrong while generating your skincare advice. Please try again later.`,
        { reply_markup: USER_KEYBOARD },
      );
    }
  }

  // ─────────────────────────────────────────────
  // /admin — enter admin mode
  // ─────────────────────────────────────────────
  @Command('admin')
  async onAdminCommand(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);

    if (this.adminSessions.isAuthenticated(chatId)) {
      await this.sendAdminMenu(ctx, 'You are already in admin mode.');
      return;
    }

    this.sessions.delete(chatId);
    this.profileEditSessions.delete(chatId);

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

    // ── Profile edit flow ────────────────────────────────────────
    const profileSession = this.profileEditSessions.get(chatId);
    if (profileSession) {
      await this.handleProfileEditFlow(ctx, chatId, profileSession, message);
      return;
    }

    // ── "👤 Profile" button press (always available) ─────────────
    if (text === '👤 Profile') {
      const telegramId = ctx.from!.id;
      const customer = await this.customerService.findByTelegramId(telegramId);
      if (customer) {
        await this.showProfileMenu(ctx, customer);
        return;
      }
    }

    // ── "💡 Get Advice" button press (always available) ──────────
    if (text === '💡 Get Advice') {
      await this.handleGetAdvice(ctx, chatId);
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
      case 'awaiting_username':
        await this.handleUsername(ctx, chatId, session, message);
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
  // Profile edit flow
  // ─────────────────────────────────────────────

  private async handleProfileEditFlow(
    ctx: Context,
    chatId: string,
    session: ProfileEditSession,
    message: Message.TextMessage & Message.ContactMessage,
  ) {
    const text = ('text' in message ? message.text : '').trim();

    // ── Step 1: User chooses which field to edit ──
    if (session.step === 'choosing_field') {
      if (text === '❌ Cancel') {
        this.profileEditSessions.delete(chatId);
        await ctx.reply(`Profile edit cancelled.`, {
          reply_markup: USER_KEYBOARD,
        });
        return;
      }

      if (text === '📝 Edit Name') {
        session.step = 'awaiting_name';
        session.field = 'name';
        this.profileEditSessions.set(chatId, session);
        await ctx.reply(`What is your new full name?`, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }

      if (text === '📞 Edit Phone') {
        session.step = 'awaiting_phone';
        session.field = 'phone';
        this.profileEditSessions.set(chatId, session);
        await ctx.reply(
          `Share your new phone number.\nYou can tap the button or type it manually.`,
          {
            reply_markup: {
              keyboard: [
                [
                  {
                    text: '📱 Share my phone number',
                    request_contact: true,
                  },
                ],
              ],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          },
        );
        return;
      }

      if (text === '🌿 Edit Skin Type') {
        session.step = 'awaiting_skin_type';
        session.field = 'skinType';
        this.profileEditSessions.set(chatId, session);

        const skinTypes = await this.skinTypeService.findAll();
        if (skinTypes.length === 0) {
          await ctx.reply(
            `No skin types available. Contact support to update this.`,
            { reply_markup: { remove_keyboard: true } },
          );
          this.profileEditSessions.delete(chatId);
          return;
        }

        const keyboard = skinTypes.map((st) => [{ text: st.name }]);
        await ctx.reply(`Choose your new skin type:`, {
          reply_markup: {
            keyboard,
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        });
        return;
      }

      if (text === '📍 Edit Address') {
        session.step = 'awaiting_address';
        session.field = 'address';
        this.profileEditSessions.set(chatId, session);
        await ctx.reply(`What is your new delivery address?`, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }

      await ctx.reply(`Please choose a field to edit using the buttons.`);
      return;
    }

    // ── Step 2: User provides new value ──
    switch (session.step) {
      case 'awaiting_name':
        await this.handleProfileEditName(ctx, chatId, session, message);
        break;
      case 'awaiting_phone':
        await this.handleProfileEditPhone(ctx, chatId, session, message);
        break;
      case 'awaiting_skin_type':
        await this.handleProfileEditSkinType(ctx, chatId, session, message);
        break;
      case 'awaiting_address':
        await this.handleProfileEditAddress(ctx, chatId, session, message);
        break;
      default:
        break;
    }
  }

  private async handleProfileEditName(
    ctx: Context,
    chatId: string,
    session: ProfileEditSession,
    message: Message.TextMessage,
  ) {
    const name = message.text?.trim();
    if (!name || name.length < 2) {
      await ctx.reply(
        'Please enter a valid name (at least 2 characters).',
      );
      return;
    }

    try {
      await this.customerService.update(session.customerId, {
        fullName: name,
      });
      this.profileEditSessions.delete(chatId);
      await ctx.reply(`✅ Your name has been updated to: ${name}`, {
        reply_markup: USER_KEYBOARD,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update name: ${msg}`);
      await ctx.reply(`Failed to update. Please try again later.`, {
        reply_markup: USER_KEYBOARD,
      });
      this.profileEditSessions.delete(chatId);
    }
  }

  private async handleProfileEditPhone(
    ctx: Context,
    chatId: string,
    session: ProfileEditSession,
    message: Message.TextMessage & Message.ContactMessage,
  ) {
    let phone: string | undefined;

    if ('contact' in message && message.contact?.phone_number) {
      phone = message.contact.phone_number;
    } else if ('text' in message && message.text) {
      phone = message.text.trim();
    }

    if (!phone || phone.length < 7) {
      await ctx.reply('Please share a valid phone number.');
      return;
    }

    try {
      await this.customerService.update(session.customerId, { phone });
      this.profileEditSessions.delete(chatId);
      await ctx.reply(`✅ Your phone has been updated to: ${phone}`, {
        reply_markup: USER_KEYBOARD,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update phone: ${msg}`);
      await ctx.reply(`Failed to update. Please try again later.`, {
        reply_markup: USER_KEYBOARD,
      });
      this.profileEditSessions.delete(chatId);
    }
  }

  private async handleProfileEditSkinType(
    ctx: Context,
    chatId: string,
    session: ProfileEditSession,
    message: Message.TextMessage,
  ) {
    const input = message.text?.trim();
    if (!input) {
      await ctx.reply('Please select a skin type from the options.');
      return;
    }

    const skinTypes = await this.skinTypeService.findAll();
    const match = skinTypes.find(
      (st) => st.name.toLowerCase() === input.toLowerCase(),
    );

    try {
      await this.customerService.update(session.customerId, {
        skinTypeId: match?.id ?? null,
      });
      this.profileEditSessions.delete(chatId);
      const displayName = match ? match.name : 'Not specified';
      await ctx.reply(`✅ Your skin type has been updated to: ${displayName}`, {
        reply_markup: USER_KEYBOARD,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update skin type: ${msg}`);
      await ctx.reply(`Failed to update. Please try again later.`, {
        reply_markup: USER_KEYBOARD,
      });
      this.profileEditSessions.delete(chatId);
    }
  }

  private async handleProfileEditAddress(
    ctx: Context,
    chatId: string,
    session: ProfileEditSession,
    message: Message.TextMessage,
  ) {
    const address = message.text?.trim();
    if (!address || address.length < 5) {
      await ctx.reply('Please enter a valid address (at least 5 characters).');
      return;
    }

    try {
      await this.customerService.update(session.customerId, { address });
      this.profileEditSessions.delete(chatId);
      await ctx.reply(`✅ Your address has been updated to: ${address}`, {
        reply_markup: USER_KEYBOARD,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update address: ${msg}`);
      await ctx.reply(`Failed to update. Please try again later.`, {
        reply_markup: USER_KEYBOARD,
      });
      this.profileEditSessions.delete(chatId);
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
      return;
    }

    this.adminSessions.set(chatId, { step: 'authenticated' });
    this.logger.log(`Admin authenticated for chatId=${chatId}`);
    await this.sendAdminMenu(ctx, `✅ Access granted. Welcome, Admin!`);
  }

  private async sendAdminMenu(ctx: Context, headerText: string) {
    await ctx.reply(`${headerText}\n\nUse the buttons below to manage your store:`, {
      reply_markup: ADMIN_KEYBOARD,
    });
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
        await ctx.reply(`👋 You have been logged out of admin mode.`, {
          reply_markup: USER_KEYBOARD,
        });
        break;

      default:
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
      .slice(0, 20)
      .map((c, i) => `${i + 1}. ${c.fullName} — ${c.phone}`)
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
    session.step = 'awaiting_username';
    this.sessions.set(chatId, session);

    const knownUsername = ctx.from?.username?.trim();
    if (knownUsername) {
      await ctx.reply(
        `Great, ${name}! 👍\n\nPlease share your Telegram username.\n` +
          `We detected @${knownUsername} — tap the button below to use it, or type a different one.`,
        {
          reply_markup: {
            keyboard: [[{ text: `@${knownUsername}` }], [{ text: 'Skip' }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
      return;
    }

    await ctx.reply(
      `Great, ${name}! 👍\n\nPlease share your Telegram username (e.g. @yourname).\n` +
        `Type it below, or tap Skip if you don't have one.`,
      {
        reply_markup: {
          keyboard: [[{ text: 'Skip' }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
  }

  private async handleUsername(
    ctx: Context,
    chatId: string,
    session: RegistrationSession,
    message: Message.TextMessage,
  ) {
    const raw = message.text?.trim() ?? '';
    const lower = raw.toLowerCase();

    if (lower === 'skip' || lower === 'skip for now') {
      session.telegramUsername = null;
    } else {
      const cleaned = raw.replace(/^@/, '').trim();
      if (!/^[a-zA-Z0-9_]{5,32}$/.test(cleaned)) {
        await ctx.reply(
          'Please enter a valid Telegram username (5–32 letters, numbers, or underscores), or tap Skip.',
        );
        return;
      }
      session.telegramUsername = cleaned;
    }

    session.step = 'awaiting_phone';
    this.sessions.set(chatId, session);

    await ctx.reply(
      `Thanks! 🙌\n\nNow please share your phone number | ስልኮን ያጋሩን.\n` +
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
        telegramUsername: session.telegramUsername ?? ctx.from?.username ?? null,
      });

      this.sessions.delete(chatId);

      const usernameLine = session.telegramUsername
        ? `🔗 Username: @${session.telegramUsername}\n`
        : '';

      await ctx.reply(
        `You are all set, ${session.fullName}! 🎉\n\n` +
          `Here is a summary of your registration:\n\n` +
          `👤 Name: ${session.fullName}\n` +
          usernameLine +
          `📞 Phone: ${session.phone}\n` +
          `🌿 Skin type: ${session.skinTypeId ? 'Saved' : 'Not specified'}\n` +
          `📍 Address: ${address}\n\n` +
          `Welcome to the Medaf Skin Care family! We will keep you updated on ` +
          `new arrivals, offers, and skincare tips. 😊`,
        { reply_markup: USER_KEYBOARD },
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
