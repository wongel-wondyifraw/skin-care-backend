import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import {
  SettingsService,
  PaymentInfo,
  DeliveryOrigin,
  DeliveryRate,
} from './settings.service.js';

class UpdateShopSettingsDto {
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  trendingProductIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentInfo)
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

  @Get('delivery-origin')
  getDeliveryOrigin() {
    return this.settingsService.getDeliveryOrigin();
  }

  @Put('delivery-origin')
  setDeliveryOrigin(@Body() body: DeliveryOrigin) {
    return this.settingsService.setDeliveryOrigin(body);
  }

  @Get('delivery-rate')
  getDeliveryRate() {
    return this.settingsService.getDeliveryRate();
  }

  @Put('delivery-rate')
  setDeliveryRate(@Body() body: DeliveryRate) {
    return this.settingsService.setDeliveryRate(body);
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
