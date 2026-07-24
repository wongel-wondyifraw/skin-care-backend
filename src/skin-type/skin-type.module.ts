import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SkinType } from './skin-type.entity.js';
import { SkinTypeService } from './skin-type.service.js';
import { SkinTypeController } from './skin-type.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([SkinType])],
  providers: [SkinTypeService],
  controllers: [SkinTypeController],
})
export class SkinTypeModule {}
