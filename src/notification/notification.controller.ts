import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { NotificationService } from './notification.service.js';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  async list(@Query('limit') limit?: string) {
    const items = await this.notificationService.listRecent(
      limit ? Number(limit) : 30,
    );
    const unreadCount = await this.notificationService.unreadCount();
    return { items, unreadCount };
  }

  @Get('unread-count')
  async unreadCount() {
    const unreadCount = await this.notificationService.unreadCount();
    return { unreadCount };
  }

  @Patch('read-all')
  markAllRead() {
    return this.notificationService.markAllRead();
  }

  @Patch(':id/read')
  markRead(@Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.markRead(id);
  }
}
