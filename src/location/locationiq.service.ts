import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service.js';

export interface LocationSuggestion {
  place_id: string;
  display_name: string;
  lat: string;
  lon: string;
}

@Injectable()
export class LocationIqService {
  private readonly logger = new Logger(LocationIqService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://us1.locationiq.com/v1';

  constructor(
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
  ) {
    this.apiKey = this.configService.get<string>('LOCATIONIQ_API_KEY', '');
  }

  async autocomplete(
    query: string,
    countryCode = 'et',
  ): Promise<LocationSuggestion[]> {
    if (!this.apiKey) {
      this.logger.warn('LOCATIONIQ_API_KEY is not set');
      return [];
    }

    try {
      const url = `${this.baseUrl}/autocomplete?key=${this.apiKey}&q=${encodeURIComponent(query)}&countrycodes=${countryCode}&limit=5`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `LocationIQ returned ${response.status} ${response.statusText}`,
        );
      }
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.error(`Autocomplete failed: ${(err as Error).message}`);
      return [];
    }
  }

  async getDrivingDistance(
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number,
  ): Promise<{ distanceKm: number; durationMinutes: number }> {
    if (!this.apiKey) {
      this.logger.warn('LOCATIONIQ_API_KEY is not set');
      return { distanceKm: 0, durationMinutes: 0 };
    }

    try {
      // Directions API format: {lon},{lat};{lon},{lat}
      const url = `${this.baseUrl}/directions/driving/${originLon},${originLat};${destLon},${destLat}?key=${this.apiKey}&overview=false`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `LocationIQ returned ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();

      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        // distance is in meters, duration in seconds
        return {
          distanceKm: route.distance / 1000,
          durationMinutes: Math.round(route.duration / 60),
        };
      }

      return { distanceKm: 0, durationMinutes: 0 };
    } catch (err) {
      this.logger.error(`Driving distance failed: ${(err as Error).message}`);
      return { distanceKm: 0, durationMinutes: 0 };
    }
  }

  async calculateDeliveryFee(
    destLat: number,
    destLon: number,
  ): Promise<{
    distanceKm: number;
    fee: number;
    durationMinutes: number;
    withinRadius: boolean;
  }> {
    const origin = await this.settingsService.getDeliveryOrigin();
    const rate = await this.settingsService.getDeliveryRate();

    const { distanceKm, durationMinutes } = await this.getDrivingDistance(
      origin.lat,
      origin.lon,
      destLat,
      destLon,
    );

    // Fallback if distance is 0 (e.g. api error)
    if (distanceKm === 0) {
      return {
        distanceKm: 0,
        fee: 350,
        durationMinutes: 0,
        withinRadius: true,
      };
    }

    const calculatedFee = distanceKm * rate.ratePerKm;
    const finalFee = Math.max(calculatedFee, rate.minFee);
    const withinRadius = distanceKm <= rate.maxRadiusKm;

    return {
      distanceKm: parseFloat(distanceKm.toFixed(2)),
      fee: Math.ceil(finalFee), // Round up to nearest integer
      durationMinutes,
      withinRadius,
    };
  }
}
