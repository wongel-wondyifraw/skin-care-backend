import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Action, Command, Ctx, On, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { Message } from 'telegraf/types';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { CustomerService } from '../customer/customer.service.js';
import { ProductService } from '../product/product.service.js';
import { CategoryService } from '../category/category.service.js';
import { OrderService } from '../order/order.service.js';
import { GeminiService } from './gemini.service.js';
import { CloudinaryService } from '../upload/cloudinary.service.js';
import { SkinAnalysisService } from '../skin-analysis/skin-analysis.service.js';
import { CustomerMessageService } from '../customer/customer-message.service.js';
import {
  AdminSessionStore,
  CatalogBrowseSession,
  CatalogBrowseSessionStore,
  OrderSession,
  OrderSessionStore,
  ProfileEditSession,
  ProfileEditSessionStore,
  RegistrationSession,
  RegistrationSessionStore,
  ScanSessionStore,
} from './registration.session.js';

const CATALOG_PAGE_SIZE = 8;
const MAX_PRODUCT_CARDS = 3;

// ─── Persistent admin keyboard shown at the bottom of the chat ──────────────
const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: '👤 Profile' }, { text: '💡 Get Advice' }],
    [{ text: '🔍 Scan Face' }, { text: '📦 Products' }],
    [{ text: '👥 Customers' }, { text: '🛒 Orders' }],
    [{ text: '🌐 Web Catalog' }, { text: '⚙️ Settings' }],
    [{ text: '🚪 Logout' }],
  ],
  resize_keyboard: true,
};

// ─── User keyboard with profile + products ───────────────────────────────────
const USER_KEYBOARD = {
  keyboard: [
    [{ text: '👤 Profile' }, { text: '💡 Get Advice' }],
    [{ text: '🔍 Scan Face' }, { text: '📦 Products' }],
  ],
  resize_keyboard: true,
};

/** Sticky submenu after tapping Products */
const PRODUCTS_KEYBOARD = {
  keyboard: [
    [{ text: '✨ Recommended' }, { text: '📂 Categories' }],
    [{ text: '🔍 Search Product' }, { text: '◀️ Back' }],
  ],
  resize_keyboard: true,
};

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);
  private readonly sessions = new RegistrationSessionStore();
  private readonly adminSessions = new AdminSessionStore();
  private readonly profileEditSessions = new ProfileEditSessionStore();
  private readonly orderSessions = new OrderSessionStore();
  private readonly catalogSessions = new CatalogBrowseSessionStore();
  private readonly scanSessions = new ScanSessionStore();

  constructor(
    private readonly skinTypeService: SkinTypeService,
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly categoryService: CategoryService,
    private readonly orderService: OrderService,
    private readonly geminiService: GeminiService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly skinAnalysisService: SkinAnalysisService,
    private readonly customerMessageService: CustomerMessageService,
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
      const allProducts = await this.productService.findCatalogForAdvice();

      if (allProducts.length === 0) {
        await ctx.reply(
          `Sorry, we don't have any products in our catalog yet. Please check back later!`,
          { reply_markup: USER_KEYBOARD },
        );
        return;
      }

      const userSkinType = customer.skinType?.name || null;

      // Filter: products matching user's skin type, "All", or any listed skin type
      let filteredProducts = allProducts;
      if (userSkinType && userSkinType.toLowerCase() !== 'all') {
        const target = userSkinType.toLowerCase();
        filteredProducts = allProducts.filter((p) => {
          const skins =
            p.skinTypes?.length
              ? p.skinTypes
              : p.skinType
                ? [p.skinType]
                : [];
          if (skins.length === 0) return true;
          return skins.some((s) => {
            const name = (s.name || 'All').toLowerCase();
            return name === target || name === 'all';
          });
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

      const cards = recommendedProducts.slice(0, MAX_PRODUCT_CARDS);
      for (let i = 0; i < cards.length; i++) {
        const product = cards[i];
        const price =
          product.price != null
            ? `${Number(product.price).toFixed(2)} ETB`
            : 'Price not set';

        // Caption stays short — details already appear in the advice text
        const caption = `🌿 ${product.name}\n💰 ${price}`;

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

        await this.sendProductPhotoCard(ctx, product, caption, inlineKeyboard);

        // Brief pause so Telegram reliably accepts consecutive photo uploads
        if (i < cards.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 450));
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

  /**
   * Send a product photo reliably by downloading the image first.
   * Telegram often fails on replyWithPhoto({ url }) for 2nd+ images in a burst.
   */
  private async sendProductPhotoCard(
    ctx: Context,
    product: { id: string; name: string; image?: string | null },
    caption: string,
    replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] },
  ) {
    const imageUrl = product.image?.trim();

    if (imageUrl) {
      try {
        const res = await fetch(imageUrl, {
          headers: { 'User-Agent': 'MedafSkinCareBot/1.0' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          throw new Error(`Image fetch HTTP ${res.status}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length === 0) {
          throw new Error('Empty image buffer');
        }

        const lower = imageUrl.toLowerCase();
        const filename = lower.includes('.png')
          ? `${product.id}.png`
          : lower.includes('.webp')
            ? `${product.id}.webp`
            : `${product.id}.jpg`;

        await ctx.replyWithPhoto(
          { source: buffer, filename },
          { caption, reply_markup: replyMarkup },
        );
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Buffer photo failed for "${product.name}": ${msg}. Trying URL…`,
        );
      }

      try {
        await ctx.replyWithPhoto(imageUrl, {
          caption,
          reply_markup: replyMarkup,
        });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `URL photo failed for "${product.name}": ${msg}. Falling back to text.`,
        );
      }
    } else {
      this.logger.warn(`No image URL for product "${product.name}"`);
    }

    await ctx.reply(caption, { reply_markup: replyMarkup });
  }

  private productOrderMarkup(product: { id: string; stock: number }) {
    return {
      inline_keyboard: [
        [
          {
            text: product.stock > 0 ? '🛒 Order Now' : '🔔 Notify Me',
            callback_data: `order_${product.id}`,
          },
        ],
      ],
    };
  }

  private truncateLabel(name: string, max = 40): string {
    const trimmed = name.trim();
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, max - 1)}…`;
  }

  private async showProductsMenu(ctx: Context, header?: string) {
    await ctx.reply(
      header ??
        `📦 Products\n\nChoose how you'd like to browse:`,
      { reply_markup: PRODUCTS_KEYBOARD },
    );
  }

  private async sendProductCardById(ctx: Context, productId: string) {
    try {
      const product = await this.productService.findOne(productId);
      const price =
        product.price != null
          ? `${Number(product.price).toFixed(2)} ETB`
          : 'Price not set';
      const stockNote =
        product.stock > 0 ? `In stock (${product.stock})` : 'Out of stock';
      const caption =
        `🌿 ${product.name}\n` +
        (product.brand?.trim() ? `🏷️ ${product.brand.trim()}\n` : '') +
        `💰 ${price}\n` +
        `📦 ${stockNote}`;

      await this.sendProductPhotoCard(
        ctx,
        product,
        caption,
        this.productOrderMarkup(product),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sendProductCardById failed: ${msg}`);
      await ctx.reply(`Sorry, that product is no longer available.`);
    }
  }

  private async showCategoryPicker(ctx: Context) {
    const categories = await this.categoryService.findWithProducts();
    if (categories.length === 0) {
      await ctx.reply(
        `No categories with products yet. Please check back later!`,
        { reply_markup: PRODUCTS_KEYBOARD },
      );
      return;
    }

    const rows = categories.map((c) => [
      {
        text: `📂 ${this.truncateLabel(c.name, 36)}`,
        callback_data: `pcat_${c.id}_1`,
      },
    ]);

    await ctx.reply(`📂 Pick a category:`, {
      reply_markup: { inline_keyboard: rows },
    });
  }

  private async showCategoryProductPage(
    ctx: Context,
    chatId: string,
    categoryId: string,
    page: number,
    editMessage: boolean,
  ) {
    let categoryName = 'Category';
    try {
      const cat = await this.categoryService.findOne(categoryId);
      categoryName = cat.name;
    } catch {
      /* keep default */
    }

    this.catalogSessions.set(chatId, {
      step: 'browsing',
      categoryId,
      categoryName,
    });

    const result = await this.productService.findPage({
      page,
      pageSize: CATALOG_PAGE_SIZE,
      categoryId,
      sort: 'name',
    });

    if (result.total === 0) {
      const empty = `No products in ${categoryName} yet.`;
      if (editMessage && ctx.callbackQuery) {
        await ctx.answerCbQuery(empty);
        return;
      }
      await ctx.reply(empty, { reply_markup: PRODUCTS_KEYBOARD });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);

    const productRows = result.items.map((p) => [
      {
        text: this.truncateLabel(p.name),
        callback_data: `pview_${p.id}`,
      },
    ]);

    const nav: { text: string; callback_data: string }[] = [];
    if (safePage > 1) {
      nav.push({
        text: '◀️ Prev',
        callback_data: `pcat_${categoryId}_${safePage - 1}`,
      });
    }
    nav.push({
      text: `${safePage}/${totalPages}`,
      callback_data: `pcat_${categoryId}_${safePage}`,
    });
    if (safePage < totalPages) {
      nav.push({
        text: 'Next ▶️',
        callback_data: `pcat_${categoryId}_${safePage + 1}`,
      });
    }

    const markup = {
      inline_keyboard: [
        ...productRows,
        nav,
        [{ text: '📂 All categories', callback_data: 'pcats' }],
      ],
    };

    const text =
      `📂 ${categoryName}\n` +
      `Tap a product name (${result.total} total):`;

    if (editMessage && 'editMessageText' in ctx) {
      try {
        await ctx.editMessageText(text, { reply_markup: markup });
        return;
      } catch {
        /* fall through to new message */
      }
    }

    await ctx.reply(text, { reply_markup: markup });
  }

  private async showSearchProductPage(
    ctx: Context,
    chatId: string,
    query: string,
    page: number,
    editMessage: boolean,
  ) {
    const search = query.trim();
    this.catalogSessions.set(chatId, {
      step: 'browsing',
      searchQuery: search,
    });

    const result = await this.productService.findPage({
      page,
      pageSize: CATALOG_PAGE_SIZE,
      search,
      sort: 'name',
    });

    if (result.total === 0) {
      const empty = `No products matched "${search}". Try another name.`;
      if (editMessage && ctx.callbackQuery) {
        await ctx.answerCbQuery('No matches');
      }
      await ctx.reply(empty, { reply_markup: PRODUCTS_KEYBOARD });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);

    const productRows = result.items.map((p) => [
      {
        text: this.truncateLabel(p.name),
        callback_data: `pview_${p.id}`,
      },
    ]);

    const nav: { text: string; callback_data: string }[] = [];
    if (safePage > 1) {
      nav.push({
        text: '◀️ Prev',
        callback_data: `psrch_${safePage - 1}`,
      });
    }
    nav.push({
      text: `${safePage}/${totalPages}`,
      callback_data: `psrch_${safePage}`,
    });
    if (safePage < totalPages) {
      nav.push({
        text: 'Next ▶️',
        callback_data: `psrch_${safePage + 1}`,
      });
    }

    const markup = {
      inline_keyboard: [
        ...productRows,
        nav,
        [{ text: '🔍 New search', callback_data: 'psearch_new' }],
      ],
    };

    const text =
      `🔍 Results for "${search}"\n` +
      `Tap a product (${result.total} found):`;

    if (editMessage && 'editMessageText' in ctx) {
      try {
        await ctx.editMessageText(text, { reply_markup: markup });
        return;
      } catch {
        /* fall through */
      }
    }

    await ctx.reply(text, { reply_markup: markup });
  }

  private async startProductSearch(ctx: Context, chatId: string) {
    this.catalogSessions.set(chatId, { step: 'awaiting_search' });
    await ctx.reply(
      `🔍 Search products\n\nType a product name (or part of it):`,
      {
        reply_markup: {
          keyboard: [[{ text: '◀️ Back' }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
  }

  // ─────────────────────────────────────────────
  // Catalog browse callbacks
  // ─────────────────────────────────────────────

  @Action('pcats')
  async onCatalogCategories(@Ctx() ctx: Context) {
    await ctx.answerCbQuery();
    await this.showCategoryPicker(ctx);
  }

  @Action(/^pcat_(.+)_(\d+)$/)
  async onCatalogCategoryPage(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : '';
    const match = /^pcat_(.+)_(\d+)$/.exec(data);
    if (!match) {
      await ctx.answerCbQuery();
      return;
    }
    await ctx.answerCbQuery();
    await this.showCategoryProductPage(
      ctx,
      chatId,
      match[1],
      Number(match[2]),
      true,
    );
  }

  @Action(/^psrch_(\d+)$/)
  async onCatalogSearchPage(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : '';
    const match = /^psrch_(\d+)$/.exec(data);
    const session = this.catalogSessions.get(chatId);
    if (!match || !session?.searchQuery) {
      await ctx.answerCbQuery('Search expired — start a new search.');
      return;
    }
    await ctx.answerCbQuery();
    await this.showSearchProductPage(
      ctx,
      chatId,
      session.searchQuery,
      Number(match[1]),
      true,
    );
  }

  @Action('psearch_new')
  async onCatalogSearchNew(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    await ctx.answerCbQuery();
    await this.startProductSearch(ctx, chatId);
  }

  @Action(/^pview_(.+)$/)
  async onCatalogProductView(@Ctx() ctx: Context) {
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : '';
    const match = /^pview_(.+)$/.exec(data);
    if (!match) {
      await ctx.answerCbQuery();
      return;
    }
    await ctx.answerCbQuery();
    await this.sendProductCardById(ctx, match[1]);
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
  // Inline: Order Now on product cards
  // ─────────────────────────────────────────────
  @Action(/^order_(.+)$/)
  async onOrderCallback(@Ctx() ctx: Context) {
    const chatId = String(ctx.chat!.id);
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : '';
    const productId = data.replace(/^order_/, '');

    await ctx.answerCbQuery();

    const customer = await this.customerService.findByTelegramId(ctx.from!.id);
    if (!customer) {
      await ctx.reply(
        `Please register first with /start before placing an order.`,
        { reply_markup: USER_KEYBOARD },
      );
      return;
    }

    let product;
    try {
      product = await this.productService.findOne(productId);
    } catch {
      await ctx.reply(`Sorry, that product is no longer available.`, {
        reply_markup: USER_KEYBOARD,
      });
      return;
    }

    if (product.stock <= 0) {
      await ctx.reply(
        `🔔 Thanks! We'll notify you when "${product.name}" is back in stock.`,
        { reply_markup: USER_KEYBOARD },
      );
      return;
    }

    this.profileEditSessions.delete(chatId);
    this.orderSessions.set(chatId, {
      step: 'awaiting_quantity',
      productId: product.id,
      customerId: customer.id,
      cost: Number(product.price) || 0,
      productName: product.name,
      maxStock: product.stock,
    });

    const qtyButtons = [
      [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }],
      [{ text: '❌ Cancel order' }],
    ];

    await ctx.reply(
      `🛒 Ordering: ${product.name}\n` +
        `💰 Unit price: ${Number(product.price).toFixed(2)} ETB\n` +
        `📦 In stock: ${product.stock}\n\n` +
        `How many would you like?\n` +
        `Tap 1–4, or type a number if you need more.`,
      {
        reply_markup: {
          keyboard: qtyButtons,
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
  }

  // ─────────────────────────────────────────────
  // Inline: Cancel a pending order
  // ─────────────────────────────────────────────
  @Action(/^cancel_order_(.+)$/)
  async onCancelOrderCallback(@Ctx() ctx: Context) {
    const data =
      ctx.callbackQuery && 'data' in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : '';
    const orderId = data.replace(/^cancel_order_/, '');

    const customer = await this.customerService.findByTelegramId(ctx.from!.id);
    if (!customer) {
      await ctx.answerCbQuery('Please register first.');
      return;
    }

    try {
      const order = await this.orderService.findOne(orderId);
      if (order.customerId !== customer.id) {
        await ctx.answerCbQuery('This order is not yours.');
        return;
      }
      if (order.status !== 'pending') {
        await ctx.answerCbQuery(`Order is already ${order.status}.`);
        return;
      }

      await this.orderService.updateStatus(orderId, 'cancelled');
      await ctx.answerCbQuery('Order cancelled');
      await ctx.reply(
        `❌ Order cancelled.\n\n🌿 ${order.product?.name ?? 'Product'}\n` +
          `Qty: ${order.quantity}\nNo stock was changed.`,
        { reply_markup: USER_KEYBOARD },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Cancel order failed: ${msg}`);
      await ctx.answerCbQuery('Could not cancel this order.');
    }
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

    // ── Facial scan photo ────────────────────────────────────────
    if (this.scanSessions.has(chatId) && this.isPhotoMessage(ctx)) {
      await this.handleScanPhoto(ctx, chatId);
      return;
    }

    // ── Order flow (quantity → address) ──────────────────────────
    const orderSession = this.orderSessions.get(chatId);
    if (orderSession) {
      await this.handleOrderFlow(ctx, chatId, orderSession, text);
      return;
    }

    if (this.scanSessions.has(chatId)) {
      if (
        text === '◀️ Back' ||
        text === '👤 Profile' ||
        text === '💡 Get Advice' ||
        text === '📦 Products' ||
        text === '🔍 Scan Face'
      ) {
        this.scanSessions.delete(chatId);
      } else if (!text) {
        await ctx.reply(
          `Please send a clear face photo, or tap ◀️ Back to cancel.`,
          {
            reply_markup: {
              keyboard: [[{ text: '◀️ Back' }]],
              resize_keyboard: true,
            },
          },
        );
        return;
      } else {
        await ctx.reply(
          `Send a photo of your face (not text), or tap ◀️ Back to cancel.`,
        );
        return;
      }
    }

    // ── Product search query ─────────────────────────────────────
    const catalogSession = this.catalogSessions.get(chatId);
    if (catalogSession?.step === 'awaiting_search') {
      if (text === '◀️ Back' || text === '📦 Products') {
        this.catalogSessions.delete(chatId);
        await this.showProductsMenu(ctx);
        return;
      }
      if (!text || text.length < 2) {
        await ctx.reply(`Please type at least 2 characters to search.`);
        return;
      }
      await this.showSearchProductPage(ctx, chatId, text, 1, false);
      await ctx.reply(`Use the menu below to browse more:`, {
        reply_markup: PRODUCTS_KEYBOARD,
      });
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
      this.catalogSessions.delete(chatId);
      const telegramId = ctx.from!.id;
      const customer = await this.customerService.findByTelegramId(telegramId);
      if (customer) {
        await this.showProfileMenu(ctx, customer);
        return;
      }
    }

    // ── "💡 Get Advice" button press (always available) ──────────
    if (text === '💡 Get Advice') {
      this.catalogSessions.delete(chatId);
      this.scanSessions.delete(chatId);
      await this.handleGetAdvice(ctx, chatId);
      return;
    }

    if (text === '🔍 Scan Face') {
      this.catalogSessions.delete(chatId);
      await this.startFaceScan(ctx, chatId);
      return;
    }

    // ── Products browse (user + admin sticky) ────────────────────
    if (text === '📦 Products') {
      this.catalogSessions.delete(chatId);
      await this.showProductsMenu(ctx);
      return;
    }

    if (text === '✨ Recommended') {
      this.catalogSessions.delete(chatId);
      await this.handleGetAdvice(ctx, chatId);
      return;
    }

    if (text === '📂 Categories') {
      this.catalogSessions.delete(chatId);
      await this.showCategoryPicker(ctx);
      return;
    }

    if (text === '🔍 Search Product') {
      await this.startProductSearch(ctx, chatId);
      return;
    }

    if (text === '◀️ Back') {
      this.catalogSessions.delete(chatId);
      this.scanSessions.delete(chatId);
      const replyMarkup = this.adminSessions.isAuthenticated(chatId)
        ? ADMIN_KEYBOARD
        : USER_KEYBOARD;
      await ctx.reply(`Main menu:`, { reply_markup: replyMarkup });
      return;
    }

    // ── Admin menu button presses ────────────────────────────────
    if (this.adminSessions.isAuthenticated(chatId)) {
      await this.handleAdminMenuAction(ctx, chatId, text);
      return;
    }

    // ── Registration flow ────────────────────────────────────────
    const session = this.sessions.get(chatId);
    if (session) {
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
      return;
    }

    if (text && !this.isKnownKeyboardLabel(text)) {
      const customer = await this.customerService.findByTelegramId(ctx.from!.id);
      if (customer) {
        try {
          await this.customerMessageService.recordInbound(customer.id, text);
          await ctx.reply(
            `Thanks — our team received your message and will reply here soon.`,
            { reply_markup: USER_KEYBOARD },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to store inbound message: ${msg}`);
        }
      }
    }
    return;
  }

  private isPhotoMessage(ctx: Context): boolean {
    const msg = ctx.message as Message.PhotoMessage | undefined;
    return Boolean(msg && 'photo' in msg && msg.photo?.length);
  }

  private isKnownKeyboardLabel(text: string): boolean {
    return [
      '👤 Profile',
      '💡 Get Advice',
      '🔍 Scan Face',
      '📦 Products',
      '✨ Recommended',
      '📂 Categories',
      '🔍 Search Product',
      '◀️ Back',
      '👥 Customers',
      '🛒 Orders',
      '🌐 Web Catalog',
      '⚙️ Settings',
      '🚪 Logout',
      '❌ Cancel order',
      'Skip',
    ].includes(text);
  }

  private async startFaceScan(ctx: Context, chatId: string) {
    const customer = await this.customerService.findByTelegramId(ctx.from!.id);
    if (!customer) {
      await ctx.reply(
        `Please complete your registration first by sending /start.`,
        { reply_markup: USER_KEYBOARD },
      );
      return;
    }

    this.scanSessions.set(chatId, {
      step: 'awaiting_scan_photo',
      customerId: customer.id,
    });

    await ctx.reply(
      `🔍 Scan Face\n\n` +
        `Send a clear, front-facing photo of your face in good light.\n` +
        `One face only — no heavy filters.\n\n` +
        `This is not a medical diagnosis.`,
      {
        reply_markup: {
          keyboard: [[{ text: '◀️ Back' }]],
          resize_keyboard: true,
        },
      },
    );
  }

  private async handleScanPhoto(ctx: Context, chatId: string) {
    const session = this.scanSessions.get(chatId);
    if (!session) return;

    const msg = ctx.message as Message.PhotoMessage;
    const best = msg.photo[msg.photo.length - 1];

    await ctx.reply(`⏳ Looking at your photo… this may take a few seconds.`);

    try {
      const fileLink = await ctx.telegram.getFileLink(best.file_id);
      const res = await fetch(fileLink.href, {
        headers: { 'User-Agent': 'MedafSkinCareBot/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Telegram file HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) throw new Error('Empty photo');

      const path = fileLink.pathname.toLowerCase();
      const mimeType = path.endsWith('.png')
        ? 'image/png'
        : path.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';

      const customer = await this.customerService.findOne(session.customerId);
      const allProducts = await this.productService.findCatalogForAdvice();
      const userSkinType = customer.skinType?.name || null;

      let filteredProducts = allProducts;
      if (userSkinType && userSkinType.toLowerCase() !== 'all') {
        const target = userSkinType.toLowerCase();
        filteredProducts = allProducts.filter((p) => {
          const skins =
            p.skinTypes?.length ? p.skinTypes : p.skinType ? [p.skinType] : [];
          if (skins.length === 0) return true;
          return skins.some((s) => {
            const name = (s.name || 'All').toLowerCase();
            return name === target || name === 'all';
          });
        });
      }

      const analysis = await this.geminiService.analyzeFaceScan({
        imageBuffer: buffer,
        mimeType,
        userSkinType,
        products: filteredProducts,
      });

      if (!analysis.usable) {
        await ctx.reply(
          analysis.retryMessage ||
            `Please send a clearer front-facing photo in good light — one face, no heavy filter.`,
          {
            reply_markup: {
              keyboard: [[{ text: '◀️ Back' }]],
              resize_keyboard: true,
            },
          },
        );
        return;
      }

      const uploaded = await this.cloudinaryService.uploadBuffer(buffer, {
        folder: 'medaf_skincare_scans',
        filename: `scan-${customer.id}`,
      });

      await this.skinAnalysisService.create({
        customerId: customer.id,
        imageUrl: uploaded.secure_url,
        assetId: uploaded.asset_id || uploaded.public_id,
        adviceText: analysis.text,
        mentionedProductIds: analysis.mentionedProducts.map((p) => p.id),
      });

      this.scanSessions.delete(chatId);

      const maxLength = 4000;
      if (analysis.text.length <= maxLength) {
        await ctx.reply(analysis.text);
      } else {
        let remaining = analysis.text;
        while (remaining.length > 0) {
          if (remaining.length <= maxLength) {
            await ctx.reply(remaining);
            break;
          }
          let splitAt = remaining.lastIndexOf('\n', maxLength);
          if (splitAt === -1 || splitAt < maxLength / 2) splitAt = maxLength;
          await ctx.reply(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt).trim();
        }
      }

      if (analysis.mentionedProducts.length > 0) {
        await ctx.reply(`🛍️ Suggested products from our catalog:`);
        const cards = analysis.mentionedProducts.slice(0, MAX_PRODUCT_CARDS);
        for (let i = 0; i < cards.length; i++) {
          const product = cards[i];
          const price =
            product.price != null
              ? `${Number(product.price).toFixed(2)} ETB`
              : 'Price not set';
          await this.sendProductPhotoCard(
            ctx,
            product,
            `🌿 ${product.name}\n💰 ${price}`,
            this.productOrderMarkup(product),
          );
          if (i < cards.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 450));
          }
        }
      }

      await ctx.reply(
        `This is observational advice only — not a medical diagnosis.`,
        {
          reply_markup: this.adminSessions.isAuthenticated(chatId)
            ? ADMIN_KEYBOARD
            : USER_KEYBOARD,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Face scan failed for chatId=${chatId}: ${msg}`);
      await ctx.reply(
        `Sorry, we could not analyze that photo. Please try again with a clearer image.`,
        {
          reply_markup: {
            keyboard: [[{ text: '◀️ Back' }]],
            resize_keyboard: true,
          },
        },
      );
    }
  }

  private async handleOrderFlow(
    ctx: Context,
    chatId: string,
    session: OrderSession,
    text: string,
  ) {
    if (text === '❌ Cancel order') {
      this.orderSessions.delete(chatId);
      await ctx.reply(`Order cancelled.`, { reply_markup: USER_KEYBOARD });
      return;
    }

    if (session.step === 'awaiting_quantity') {
      const qty = Number.parseInt(text, 10);
      if (!Number.isFinite(qty) || qty < 1) {
        await ctx.reply(
          `Please tap 1–4 or type a whole number (1 or more).`,
          {
            reply_markup: {
              keyboard: [
                [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }],
                [{ text: '❌ Cancel order' }],
              ],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          },
        );
        return;
      }

      if (qty > session.maxStock) {
        await ctx.reply(
          `Only ${session.maxStock} in stock. Please choose a smaller quantity.`,
          {
            reply_markup: {
              keyboard: [
                [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }],
                [{ text: '❌ Cancel order' }],
              ],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          },
        );
        return;
      }

      session.quantity = qty;
      session.step = 'awaiting_delivery_address';
      this.orderSessions.set(chatId, session);

      const lineTotal = session.cost * qty;
      await ctx.reply(
        `Qty: ${qty} × ${session.cost.toFixed(2)} = ${lineTotal.toFixed(2)} ETB\n\n` +
          `Optionally enter a delivery address, or tap Skip to place the order without one.`,
        {
          reply_markup: {
            keyboard: [[{ text: 'Skip' }], [{ text: '❌ Cancel order' }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
      return;
    }

    // awaiting_delivery_address
    const skip = !text || text.toLowerCase() === 'skip';
    const deliveryAddress = skip ? null : text;
    const quantity = session.quantity ?? 1;

    try {
      const order = await this.orderService.create({
        customerId: session.customerId,
        productId: session.productId,
        cost: session.cost,
        quantity,
        deliveryAddress,
      });
      this.orderSessions.delete(chatId);

      const lineTotal = session.cost * quantity;
      const addressLine = deliveryAddress
        ? `📍 Delivery: ${deliveryAddress}\n`
        : `📍 Delivery: not provided\n`;

      await ctx.reply(
        `✅ Order placed!\n\n` +
          `🌿 ${session.productName}\n` +
          `📦 Qty: ${quantity}\n` +
          `💰 ${lineTotal.toFixed(2)} ETB\n` +
          addressLine +
          `⏳ Status: pending\n\n` +
          `We'll contact you soon to confirm delivery.\n` +
          `You can cancel this order while it is still pending.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '❌ Cancel order',
                  callback_data: `cancel_order_${order.id}`,
                },
              ],
            ],
          },
        },
      );
      await ctx.reply(`Use the menu below anytime:`, {
        reply_markup: USER_KEYBOARD,
      });
    } catch (err) {
      this.orderSessions.delete(chatId);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to create order: ${msg}`);
      const userMsg = /insufficient stock/i.test(msg)
        ? `Sorry, that quantity is no longer available. Please try again with a smaller quantity.`
        : `Sorry, we couldn't place your order. Please try again.`;
      await ctx.reply(userMsg, { reply_markup: USER_KEYBOARD });
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
      case '🌐 Web Catalog':
        await ctx.reply(
          `🌐 Web Catalog\n\nManage your product catalogue via the web admin panel:\n` +
            `https://skin-care-frontend-ecru.vercel.app/admin/products`,
          { reply_markup: ADMIN_KEYBOARD },
        );
        break;

      case '👥 Customers':
        await this.handleCustomersAction(ctx);
        break;

      case '🛒 Orders':
        await ctx.reply(
          `🛒 Orders\n\nView and manage orders in the web admin panel:\n` +
            `https://skin-care-frontend-ecru.vercel.app/admin/orders`,
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
        this.catalogSessions.delete(chatId);
        this.scanSessions.delete(chatId);
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
    const { items, total } = await this.customerService.findPage({
      page: 1,
      pageSize: 20,
    });

    if (total === 0) {
      await ctx.reply(`👥 No registered customers yet.`, {
        reply_markup: ADMIN_KEYBOARD,
      });
      return;
    }

    const summary = items
      .map((c, i) => `${i + 1}. ${c.fullName} — ${c.phone}`)
      .join('\n');

    const note = total > items.length ? `\n\n...and ${total - items.length} more.` : '';

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
