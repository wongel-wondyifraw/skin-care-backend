import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminUser } from './admin-user.entity.js';
import { AdminUserService } from './admin-user.service.js';
import { AdminUserController } from './admin-user.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([AdminUser])],
  providers: [AdminUserService],
  controllers: [AdminUserController],
  exports: [AdminUserService],
})
export class AdminUserModule {}
