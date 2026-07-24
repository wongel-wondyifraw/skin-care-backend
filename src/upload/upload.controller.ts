import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CloudinaryService } from './cloudinary.service';
// Removed Express import to fix TS1272

@Controller('upload')
export class UploadController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  @Post('image')
  @UseInterceptors(FileInterceptor('image'))
  async uploadImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    try {
      const result = await this.cloudinaryService.uploadFile(file);
      // We return the secure_url and assetId from Cloudinary
      return { 
        url: result.secure_url,
        assetId: result.asset_id || result.public_id 
      };
    } catch (error) {
      throw new BadRequestException('Image upload failed');
    }
  }
}
