import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomerMessage } from './customer-message.entity.js';
import { Customer } from './customer.entity.js';
import { TelegramService } from '../telegram/telegram.service.js';

@Injectable()
export class CustomerMessageService {
  constructor(
    @InjectRepository(CustomerMessage)
    private readonly repo: Repository<CustomerMessage>,
    @InjectRepository(Customer)
    private readonly customerRepo: Repository<Customer>,
    private readonly telegramService: TelegramService,
  ) {}

  async listForCustomer(customerId: string): Promise<CustomerMessage[]> {
    const exists = await this.customerRepo.exists({ where: { id: customerId } });
    if (!exists) throw new NotFoundException(`Customer ${customerId} not found`);

    return this.repo.find({
      where: { customerId },
      relations: { adminUser: true },
      select: {
        id: true,
        customerId: true,
        direction: true,
        body: true,
        adminUserId: true,
        createdAt: true,
        adminUser: { id: true, name: true, email: true },
      },
      order: { createdAt: 'ASC' },
    });
  }

  async recordInbound(customerId: string, body: string): Promise<CustomerMessage> {
    const msg = this.repo.create({
      customerId,
      direction: 'inbound',
      body,
      adminUserId: null,
    });
    return this.repo.save(msg);
  }

  async sendOutbound(
    customerId: string,
    body: string,
    adminUserId: string,
  ): Promise<CustomerMessage> {
    const customer = await this.customerRepo.findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer ${customerId} not found`);

    const text = body.trim();
    if (!text) throw new BadRequestException('Message text is required');

    await this.telegramService.sendMessage(String(customer.telegramId), text);

    const msg = this.repo.create({
      customerId,
      direction: 'outbound',
      body: text,
      adminUserId,
    });
    return this.repo.save(msg);
  }
}
