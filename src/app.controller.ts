import { Controller, Get, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  root() {
    return this.appService.getHealth();
  }

  @Get('health')
  health() {
    return this.appService.getHealth();
  }

  @UseGuards(JwtAuthGuard)
  @Get('dashboard-summary')
  getDashboardSummary() {
    return this.appService.getDashboardSummary();
  }
}
