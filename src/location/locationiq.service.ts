import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service.js';

export interface LocationSuggestion {
  place_id: string;
  display_name: string;
  lat: string;
  lon: string;
}

export interface ReverseGeocodeResult {
  displayName: string;
  lat: number;
  lon: number;
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

  async reverseGeocode(
    lat: number,
    lon: number,
  ): Promise<ReverseGeocodeResult | null> {
    if (!this.apiKey) {
      this.logger.warn('LOCATIONIQ_API_KEY is not set');
      return null;
    }

    try {
      const url = `${this.baseUrl}/reverse?key=${this.apiKey}&lat=${lat}&lon=${lon}&format=json`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `LocationIQ reverse returned ${response.status} ${response.statusText}`,
        );
      }
      const data = (await response.json()) as {
        display_name?: string;
        lat?: string;
        lon?: string;
      };
      const displayName =
        typeof data.display_name === 'string' && data.display_name.trim()
          ? data.display_name.trim()
          : 'Your location';
      return {
        displayName,
        lat: Number(data.lat) || lat,
        lon: Number(data.lon) || lon,
      };
    } catch (err) {
      this.logger.error(`Reverse geocode failed: ${(err as Error).message}`);
      return {
        displayName: 'Your location',
        lat,
        lon,
      };
    }
  }

  /** Straight-line distance when driving directions are unavailable */
  private haversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async getDrivingDistance(
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number,
  ): Promise<{ distanceKm: number; durationMinutes: number }> {
    const fallbackKm = this.haversineKm(
      originLat,
      originLon,
      destLat,
      destLon,
    );
    const fallbackDuration = Math.max(1, Math.round((fallbackKm / 25) * 60));

    if (!this.apiKey) {
      this.logger.warn(
        'LOCATIONIQ_API_KEY is not set — using straight-line distance',
      );
      return { distanceKm: fallbackKm, durationMinutes: fallbackDuration };
    }

    try {
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
        const distanceKm = Number(route.distance) / 1000;
        if (Number.isFinite(distanceKm) && distanceKm > 0) {
          return {
            distanceKm,
            durationMinutes: Math.round(Number(route.duration) / 60) || fallbackDuration,
          };
        }
      }

      this.logger.warn(
        'LocationIQ directions empty — using straight-line distance',
      );
      return { distanceKm: fallbackKm, durationMinutes: fallbackDuration };
    } catch (err) {
      this.logger.error(
        `Driving distance failed: ${(err as Error).message} — using straight-line`,
      );
      return { distanceKm: fallbackKm, durationMinutes: fallbackDuration };
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
    bandLabel: string | null;
  }> {
    const origin = await this.settingsService.getDeliveryOrigin();
    const rate = await this.settingsService.getDeliveryRate();

    if (
      !Number.isFinite(destLat) ||
      !Number.isFinite(destLon) ||
      !Number.isFinite(origin.lat) ||
      !Number.isFinite(origin.lon)
    ) {
      return {
        distanceKm: 0,
        fee: 0,
        durationMinutes: 0,
        withinRadius: false,
        bandLabel: null,
      };
    }

    const { distanceKm, durationMinutes } = await this.getDrivingDistance(
      origin.lat,
      origin.lon,
      destLat,
      destLon,
    );

    const rounded = parseFloat(Math.max(0, distanceKm).toFixed(2));
    const priced = this.settingsService.feeForDistanceKm(rounded, rate);

    return {
      distanceKm: rounded,
      fee: priced.fee,
      durationMinutes,
      withinRadius: priced.withinRadius,
      bandLabel: priced.bandLabel,
    };
  }
}
