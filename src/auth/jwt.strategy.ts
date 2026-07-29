import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { type Request } from 'express';
import { JwtPayload } from './auth.service.js';
import { AdminUserService } from '../admin-user/admin-user.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly adminUserService: AdminUserService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: Request) => req?.cookies?.adminToken ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.adminUserService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Admin user not found');
    }
    // Always use DB values so profile edits persist across reloads
    return { id: user.id, email: user.email, name: user.name };
  }
}
