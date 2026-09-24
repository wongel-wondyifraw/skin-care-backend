import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SettingsModule } from '../settings/settings.module.js';
import { LocationIqService } from './locationiq.service.js';
import { LocationController } from './location.controller.js';

@Module({
  imports: [ConfigModule, SettingsModule],
  providers: [LocationIqService],
  controllers: [LocationController],
  exports: [LocationIqService],
})
export class LocationModule {}
