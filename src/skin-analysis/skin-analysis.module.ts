import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SkinAnalysis } from './skin-analysis.entity.js';
import { Product } from '../product/product.entity.js';
import { SkinAnalysisService } from './skin-analysis.service.js';
import { SkinAnalysisController } from './skin-analysis.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([SkinAnalysis, Product])],
  providers: [SkinAnalysisService],
  controllers: [SkinAnalysisController],
  exports: [SkinAnalysisService],
})
export class SkinAnalysisModule {}
