import {
  Body,
  Controller,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AdminUserService } from './admin-user.service.js';

interface AuthRequest extends Request {
  user: { id: string; email: string; name: string };
}

@UseGuards(JwtAuthGuard)
@Controller('admin-users')
export class AdminUserController {
  constructor(private readonly adminUserService: AdminUserService) {}

  /** POST /api/admin-users — create a new admin */
  @Post()
  createAdmin(
    @Body() body: { name: string; email: string; password: string },
  ) {
    return this.adminUserService.createAdmin(body);
  }

  /** PATCH /api/admin-users/profile — update own name / password */
  @Patch('profile')
  updateProfile(
    @Req() req: AuthRequest,
    @Body()
    body: { name?: string; currentPassword?: string; newPassword?: string },
  ) {
    return this.adminUserService.updateProfile(req.user.id, body);
  }
}
