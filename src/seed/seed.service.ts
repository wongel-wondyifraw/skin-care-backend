import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AdminUserService } from '../admin-user/admin-user.service.js';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { SettingsService } from '../settings/settings.service.js';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly adminUserService: AdminUserService,
    private readonly skinTypeService: SkinTypeService,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedAdmin();
    await this.seedSkinTypes();
    await this.seedDeliveryRate();
    await this.seedPaymentInfo();
    await this.seedSupportPhone();
  }

  private async seedAdmin(): Promise<void> {
    const name = this.configService.get<string>('ADMIN_NAME', 'Admin');
    const email = this.configService.get<string>(
      'ADMIN_EMAIL',
      'admin@skincare.com',
    );
    const plainPassword = this.configService.get<string>(
      'ADMIN_PASSWORD',
      'admin@123',
    );

    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    await this.adminUserService.upsertSeedAdmin({
      name,
      email,
      hashedPassword,
    });
    this.logger.log(`Admin seed checked — ${email}`);
  }

  private async seedSkinTypes(): Promise<void> {
    try {
      const skins = await this.skinTypeService.findAll();
      const hasAcne = skins.some(
        (s) => s.name.toLowerCase().trim() === 'acne-prone skin',
      );
      if (!hasAcne) {
        await this.skinTypeService.create({
          name: 'Acne-Prone Skin',
          description:
            'Skin that is prone to acne breakouts, blackheads, and blemishes.',
        });
        this.logger.log('Seeded "Acne-Prone Skin" skin type');
      }
    } catch (err) {
      this.logger.error('Failed to seed Acne-Prone Skin', err);
    }
  }

  private async seedDeliveryRate(): Promise<void> {
    try {
      const existing = await this.settingsService.getValue('delivery_rate');
      if (!existing) {
        await this.settingsService.setDeliveryRate({
          bands: [
            { fromKm: 0, toKm: 5, fee: 100 },
            { fromKm: 5, toKm: 15, fee: 200 },
            { fromKm: 15, toKm: 30, fee: 350 },
          ],
          maxRadiusKm: 30,
        });
        this.logger.log('Seeded delivery KM bands');
      } else {
        // Ensure legacy shapes are rewritten to bands on boot
        const rate = await this.settingsService.getDeliveryRate();
        await this.settingsService.setDeliveryRate(rate);
      }
      // Drop unused keyword zones key if present
      const zones = await this.settingsService.getValue('delivery_zones');
      if (zones) {
        await this.settingsService.setValue('delivery_zones', '[]');
      }
    } catch (err) {
      this.logger.error('Failed to seed delivery rate', err);
    }
  }

  private async seedPaymentInfo(): Promise<void> {
    try {
      const existing = await this.settingsService.getValue('payment_info');
      if (!existing) {
        await this.settingsService.setPaymentInfo({
          bankAccount: {
            bankName: 'Commercial Bank of Ethiopia (CBE)',
            accountNumber: '1000XXXXXXXX',
            accountName: 'Medaf Skin Care',
          },
          telebirr: {
            phoneNumber: '09XXXXXXXX',
            accountName: 'Medaf Skin Care',
          },
        });
        this.logger.log('Seeded payment info');
      }
    } catch (err) {
      this.logger.error('Failed to seed payment info', err);
    }
  }

  private async seedSupportPhone(): Promise<void> {
    try {
      const existing = await this.settingsService.getValue('support_phone');
      if (!existing) {
        const phone = this.configService.get<string>(
          'SUPPORT_PHONE',
          '66XXXXXXXX',
        );
        await this.settingsService.setSupportPhone(phone);
        this.logger.log('Seeded support phone');
      }
    } catch (err) {
      this.logger.error('Failed to seed support phone', err);
    }
  }
}
