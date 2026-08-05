import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Customer } from './customer.entity.js';
import { AdminUser } from '../admin-user/admin-user.entity.js';

export type MessageDirection = 'inbound' | 'outbound';

@Entity('customer_messages')
export class CustomerMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  customerId: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  @Column({ type: 'varchar', length: 16 })
  direction: MessageDirection;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'uuid', nullable: true })
  adminUserId: string | null;

  @ManyToOne(() => AdminUser, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'adminUserId' })
  adminUser: AdminUser | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
