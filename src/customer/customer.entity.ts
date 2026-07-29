import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { SkinType } from '../skin-type/skin-type.entity.js';

@Entity('customers')
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Telegram user ID — unique so we can detect returning users */
  @Column({ unique: true, type: 'bigint' })
  telegramId: number;

  @Column({ length: 200 })
  fullName: string;

  @Column({ length: 30 })
  phone: string;

  @Column({ type: 'text' })
  address: string;

  /** Nullable — user may pick a skin type that doesn't match any in DB */
  @ManyToOne(() => SkinType, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'skinTypeId' })
  skinType: SkinType | null;

  @Index()
  @Column({ nullable: true })
  skinTypeId: string | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
