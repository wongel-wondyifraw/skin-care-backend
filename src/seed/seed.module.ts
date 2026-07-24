import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminUserModule } from '../admin-user/admin-user.module.js';
import { SeedService } from './seed.service.js';

@Module({
  imports: [AdminUserModule, ConfigModule],
  providers: [SeedService],
})
export class SeedModule {}
