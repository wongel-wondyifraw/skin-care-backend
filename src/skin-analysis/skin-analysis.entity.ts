import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Customer } from '../customer/customer.entity.js';

@Entity('skin_analyses')
export class SkinAnalysis {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  customerId: string;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  @Column({ type: 'text' })
  imageUrl: string;

  @Column({ type: 'varchar', nullable: true })
  assetId: string | null;

  @Column({ type: 'text' })
  adviceText: string;

  @Column({ type: 'simple-array', nullable: true })
  mentionedProductIds: string[] | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
