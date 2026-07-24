import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AdminUserService } from '../admin-user/admin-user.service.js';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly adminUserService: AdminUserService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const name = this.configService.get<string>('ADMIN_NAME', 'Admin');
    const email = this.configService.get<string>('ADMIN_EMAIL', 'admin@skincare.com');
    const plainPassword = this.configService.get<string>('ADMIN_PASSWORD', 'admin@123');

    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    await this.adminUserService.upsertSeedAdmin({ name, email, hashedPassword });
    this.logger.log(`Admin seed checked — ${email}`);
  }
}
