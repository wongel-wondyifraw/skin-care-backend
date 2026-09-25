import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { LocationIqService } from './locationiq.service.js';

@Controller('location')
export class LocationController {
  constructor(private readonly locationIqService: LocationIqService) {}

  @Get('autocomplete')
  async autocomplete(@Query('q') query: string) {
    if (!query) {
      throw new BadRequestException('Query parameter "q" is required');
    }
    return this.locationIqService.autocomplete(query);
  }

  @Get('reverse')
  async reverse(@Query('lat') latStr: string, @Query('lon') lonStr: string) {
    if (!latStr || !lonStr) {
      throw new BadRequestException('lat and lon are required');
    }
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (isNaN(lat) || isNaN(lon)) {
      throw new BadRequestException('lat and lon must be numbers');
    }
    const result = await this.locationIqService.reverseGeocode(lat, lon);
    if (!result) {
      return { displayName: 'Your location', lat, lon };
    }
    return result;
  }

  @Get('delivery-fee')
  async getDeliveryFee(
    @Query('lat') latStr: string,
    @Query('lon') lonStr: string,
  ) {
    if (!latStr || !lonStr) {
      throw new BadRequestException('lat and lon are required');
    }
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);

    if (isNaN(lat) || isNaN(lon)) {
      throw new BadRequestException('lat and lon must be numbers');
    }

    return this.locationIqService.calculateDeliveryFee(lat, lon);
  }

  @Get('config')
  getConfig() {
    return { key: process.env.LOCATIONIQ_API_KEY || '' };
  }
}
