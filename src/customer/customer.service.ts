import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from './customer.entity.js';

export interface CreateCustomerDto {
  telegramId: number;
  fullName: string;
  phone: string;
  address: string;
  skinTypeId: string | null;
}

export interface CustomerListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface PaginatedCustomers {
  items: Customer[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class CustomerService {
  private readonly logger = new Logger(CustomerService.name);

  constructor(
    @InjectRepository(Customer)
    private readonly repo: Repository<Customer>,
  ) {}

  /** Returns the existing customer record if this Telegram user already registered. */
  findByTelegramId(telegramId: number): Promise<Customer | null> {
    return this.repo.findOne({
      where: { telegramId },
      relations: { skinType: true },
    });
  }

  /** Returns all registered customers — used by the admin bot menu. */
  findAll(): Promise<Customer[]> {
    return this.repo.find({
      order: { createdAt: 'DESC' },
      relations: { skinType: true },
    });
  }

  findPage(query: CustomerListQuery): Promise<PaginatedCustomers> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 12));
    const qb = this.repo
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.skinType', 'skinType')
      .orderBy('customer.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const search = query.search?.trim();
    if (search) {
      qb.andWhere(
        `(
          LOWER(customer.fullName) LIKE :search
          OR CAST(customer.telegramId AS TEXT) LIKE :search
          OR LOWER(customer.phone) LIKE :search
          OR LOWER(customer.address) LIKE :search
          OR LOWER(COALESCE(skinType.name, '')) LIKE :search
        )`,
        { search: `%${search.toLowerCase()}%` },
      );
    }

    return qb.getManyAndCount().then(([items, total]) => ({
      items,
      total,
      page,
      pageSize,
    }));
  }

  /** Persists a brand-new customer coming from the registration flow. */
  async create(dto: CreateCustomerDto): Promise<Customer> {
    const customer = this.repo.create({
      telegramId: dto.telegramId,
      fullName: dto.fullName,
      phone: dto.phone,
      address: dto.address,
      skinTypeId: dto.skinTypeId,
    });
    const saved = await this.repo.save(customer);
    this.logger.log(
      `New customer registered: ${saved.fullName} (telegramId=${saved.telegramId})`,
    );
    return saved;
  }

  /** Updates an existing customer's profile. */
  async update(
    id: string,
    data: Partial<Pick<Customer, 'fullName' | 'phone' | 'address' | 'skinTypeId'>>,
  ): Promise<Customer> {
    await this.repo.update(id, data);
    const updated = await this.repo.findOne({
      where: { id },
      relations: { skinType: true },
    });
    if (!updated) throw new Error('Customer not found after update');
    this.logger.log(`Customer profile updated: ${updated.fullName} (id=${id})`);
    return updated;
  }
}
