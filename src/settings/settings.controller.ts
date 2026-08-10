import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SettingsService } from './settings.service.js';

class UpdateShopSettingsDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  trendingProductIds?: string[];
}

@UseGuards(JwtAuthGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('shop')
  getShop() {
    return this.settingsService.getShopSettings();
  }

  @Put('shop')
  updateShop(@Body() body: UpdateShopSettingsDto) {
    return this.settingsService.updateShopSettings(body);
  }
}
