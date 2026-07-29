import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AdminUser } from './admin-user.entity.js';

@Injectable()
export class AdminUserService {
  constructor(
    @InjectRepository(AdminUser)
    private readonly repo: Repository<AdminUser>,
  ) {}

  findByEmail(email: string): Promise<AdminUser | null> {
    return this.repo.findOne({ where: { email } });
  }

  findById(id: string): Promise<AdminUser | null> {
    return this.repo.findOne({ where: { id } });
  }

  // ── Seed ─────────────────────────────────────────────
  async upsertSeedAdmin(data: {
    name: string;
    email: string;
    hashedPassword: string;
  }): Promise<void> {
    const existing = await this.findByEmail(data.email);
    if (existing) return;
    const user = this.repo.create({
      name: data.name,
      email: data.email,
      password: data.hashedPassword,
    });
    await this.repo.save(user);
  }

  // ── Add Admin ─────────────────────────────────────────
  async createAdmin(data: {
    name: string;
    email: string;
    password: string;
  }): Promise<Omit<AdminUser, 'password'>> {
    if (!data.name || !data.email || !data.password) {
      throw new BadRequestException('Name, email and password are required');
    }
    const existing = await this.findByEmail(data.email.toLowerCase().trim());
    if (existing) throw new ConflictException('Email already in use');

    const hashed = await bcrypt.hash(data.password, 10);
    const user = this.repo.create({
      name: data.name.trim(),
      email: data.email.toLowerCase().trim(),
      password: hashed,
    });
    const saved = await this.repo.save(user);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _pw, ...rest } = saved;
    return rest;
  }

  // ── Update Profile ────────────────────────────────────
  async updateProfile(
    id: string,
    data: { name?: string; currentPassword?: string; newPassword?: string },
  ): Promise<Omit<AdminUser, 'password'>> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Admin user not found');

    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed) {
        throw new BadRequestException('Name is required');
      }
      user.name = trimmed;
    }

    if (data.newPassword) {
      if (!data.currentPassword) {
        throw new BadRequestException(
          'Current password is required to set a new password',
        );
      }
      const match = await bcrypt.compare(data.currentPassword, user.password);
      if (!match)
        throw new BadRequestException('Current password is incorrect');
      user.password = await bcrypt.hash(data.newPassword, 10);
    }

    const saved = await this.repo.save(user);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _pw, ...rest } = saved;
    return rest;
  }
}
