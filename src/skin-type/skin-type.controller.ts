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
import { SkinTypeService } from './skin-type.service.js';

@UseGuards(JwtAuthGuard)
@Controller('skin-types')
export class SkinTypeController {
  constructor(private readonly skinTypeService: SkinTypeService) {}

  @Get()
  findAll() {
    return this.skinTypeService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.skinTypeService.findOne(id);
  }

  @Post()
  create(@Body() body: { name: string; description?: string }) {
    return this.skinTypeService.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string },
  ) {
    return this.skinTypeService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.skinTypeService.remove(id);
  }
}
