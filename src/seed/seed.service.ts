import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AdminUserService } from '../admin-user/admin-user.service.js';
import { SkinTypeService } from '../skin-type/skin-type.service.js';
import { PickupLocationService } from '../pickup-location/pickup-location.service.js';
import { SettingsService } from '../settings/settings.service.js';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly adminUserService: AdminUserService,
    private readonly skinTypeService: SkinTypeService,
    private readonly pickupLocationService: PickupLocationService,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedAdmin();
    await this.seedSkinTypes();
    await this.seedPickupLocations();
    await this.seedDeliveryZones();
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

  private async seedPickupLocations(): Promise<void> {
    try {
      const existing = await this.pickupLocationService.findAll();
      if (existing.length === 0) {
        await this.pickupLocationService.create({
          name: 'Medaf HQ — Bole',
          address: 'Bole Road, Near Edna Mall, Addis Ababa',
          enabled: true,
        });
        await this.pickupLocationService.create({
          name: 'Medaf Branch — Kazanchis',
          address: 'Kazanchis, Near Hilton, Addis Ababa',
          enabled: true,
        });
        this.logger.log('Seeded initial pickup locations');
      }
    } catch (err) {
      this.logger.error('Failed to seed pickup locations', err);
    }
  }

  private async seedDeliveryZones(): Promise<void> {
    try {
      const zones = await this.settingsService.getDeliveryZones();
      if (!zones || zones.length === 0) {
        await this.settingsService.setDeliveryZones([
          {
            name: 'Bole / CMC',
            fee: 220,
            keywords: ['bole', 'cmc', 'gerji', 'summit'],
          },
          {
            name: 'Kazanchis / Piassa',
            fee: 250,
            keywords: ['kazanchis', 'piassa', 'arat kilo', 'sidist kilo'],
          },
          {
            name: 'Megenagna / Hayahulet',
            fee: 300,
            keywords: ['megenagna', 'hayahulet', 'kotebe'],
          },
          {
            name: 'Jemo / Ayat',
            fee: 400,
            keywords: ['jemo', 'ayat', 'tuludimtu'],
          },
          {
            name: 'Akaki / Kaliti',
            fee: 500,
            keywords: ['akaki', 'kaliti', 'dukem'],
          },
        ]);
        this.logger.log('Seeded initial delivery zones');
      }
    } catch (err) {
      this.logger.error('Failed to seed delivery zones', err);
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
