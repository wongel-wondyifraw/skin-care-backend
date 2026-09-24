import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PickupLocation } from './pickup-location.entity.js';
import { PickupLocationService } from './pickup-location.service.js';
import { PickupLocationController } from './pickup-location.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([PickupLocation])],
  providers: [PickupLocationService],
  controllers: [PickupLocationController],
  exports: [PickupLocationService],
})
export class PickupLocationModule {}
