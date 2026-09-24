import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PickupLocationService } from './pickup-location.service.js';

@UseGuards(JwtAuthGuard)
@Controller('pickup-locations')
export class PickupLocationController {
  constructor(private readonly pickupLocationService: PickupLocationService) {}

  @Get()
  findAll() {
    return this.pickupLocationService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.pickupLocationService.findOne(id);
  }

  @Post()
  create(
    @Body()
    body: {
      name: string;
      address: string;
      enabled?: boolean;
    },
  ) {
    return this.pickupLocationService.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      address?: string;
      enabled?: boolean;
    },
  ) {
    return this.pickupLocationService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.pickupLocationService.remove(id);
  }
}
