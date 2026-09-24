import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { VerifyEtService } from './verify-et.service.js';

@UseGuards(JwtAuthGuard)
@Controller('admin/verify-et')
export class VerifyEtController {
  constructor(private readonly verifyEtService: VerifyEtService) {}

  @Get('dashboard')
  getDashboard() {
    return this.verifyEtService.getDashboardData();
  }
}
