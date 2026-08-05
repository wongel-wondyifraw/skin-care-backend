import { Injectable, BadRequestException } from '@nestjs/common';
import {
  v2 as cloudinary,
  UploadApiResponse,
  UploadApiErrorResponse,
} from 'cloudinary';
import * as streamifier from 'streamifier';

@Injectable()
export class CloudinaryService {
  constructor() {
    // Note: ensure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET
    // are loaded into process.env by ConfigModule or standard .env
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  uploadFile(
    file: Express.Multer.File,
  ): Promise<UploadApiResponse | UploadApiErrorResponse> {
    return new Promise((resolve, reject) => {
      if (!file) {
        return reject(new BadRequestException('No file provided'));
      }

      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'medaf_skincare_products' },
        (uploadError, result) => {
          if (uploadError ?? !result) {
            return reject(
              uploadError instanceof Error
                ? uploadError
                : new Error('Upload failed or result is undefined'),
            );
          }
          resolve(result);
        },
      );

      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });
  }

  uploadBuffer(
    buffer: Buffer,
    options?: { folder?: string; filename?: string },
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      if (!buffer?.length) {
        return reject(new BadRequestException('No image buffer provided'));
      }

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: options?.folder ?? 'medaf_skincare_scans',
          filename_override: options?.filename,
        },
        (uploadError, result) => {
          if (uploadError ?? !result) {
            return reject(
              uploadError instanceof Error
                ? uploadError
                : new Error('Upload failed or result is undefined'),
            );
          }
          resolve(result);
        },
      );

      streamifier.createReadStream(buffer).pipe(uploadStream);
    });
  }
}
