import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import {
  SettingsService,
  DeliveryZone,
  PaymentInfo,
} from './settings.service.js';

class UpdateShopSettingsDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  trendingProductIds?: string[];

  @IsOptional()
  @IsArray()
  deliveryZones?: DeliveryZone[];

  @IsOptional()
  paymentInfo?: PaymentInfo;

  @IsOptional()
  @IsString()
  supportPhone?: string;
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

  @Get('delivery-zones')
  getDeliveryZones() {
    return this.settingsService.getDeliveryZones();
  }

  @Put('delivery-zones')
  setDeliveryZones(@Body() body: { zones: DeliveryZone[] }) {
    return this.settingsService.setDeliveryZones(body.zones);
  }

  @Get('payment-info')
  getPaymentInfo() {
    return this.settingsService.getPaymentInfo();
  }

  @Put('payment-info')
  setPaymentInfo(@Body() body: PaymentInfo) {
    return this.settingsService.setPaymentInfo(body);
  }

  @Get('support-phone')
  async getSupportPhone() {
    return { supportPhone: await this.settingsService.getSupportPhone() };
  }

  @Put('support-phone')
  async setSupportPhone(@Body() body: { supportPhone: string }) {
    return {
      supportPhone: await this.settingsService.setSupportPhone(
        body.supportPhone,
      ),
    };
  }
}
