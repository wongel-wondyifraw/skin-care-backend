import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminUserModule } from '../admin-user/admin-user.module.js';
import { SkinTypeModule } from '../skin-type/skin-type.module.js';
import { PickupLocationModule } from '../pickup-location/pickup-location.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { SeedService } from './seed.service.js';

@Module({
  imports: [
    AdminUserModule,
    ConfigModule,
    SkinTypeModule,
    PickupLocationModule,
    SettingsModule,
  ],
  providers: [SeedService],
})
export class SeedModule {}
