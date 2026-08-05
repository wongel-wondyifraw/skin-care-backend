import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Customer } from '../customer/customer.entity.js';
import { Product } from '../product/product.entity.js';

export type OrderStatus = 'pending' | 'delivered' | 'cancelled';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  customerId: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  @Index()
  @Column()
  productId: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'productId' })
  product: Product;

  /** Unit price at the time of order */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  cost: number;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ type: 'text', nullable: true })
  deliveryAddress: string | null;

  @Index()
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: OrderStatus;

  /** True when stock was decremented at order create time. */
  @Column({ type: 'boolean', default: false })
  stockReserved: boolean;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
