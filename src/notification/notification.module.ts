import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminNotification } from './admin-notification.entity.js';
import { NotificationService } from './notification.service.js';
import { NotificationController } from './notification.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([AdminNotification])],
  providers: [NotificationService],
  controllers: [NotificationController],
  exports: [NotificationService],
})
export class NotificationModule {}
