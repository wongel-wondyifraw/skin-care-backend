import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Category } from '../category/category.entity';
import { SkinType } from '../skin-type/skin-type.entity';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text' })
  image: string;

  @Column({ type: 'varchar', nullable: true })
  assetId: string;

  @Index()
  @Column({ nullable: true })
  categoryId: string;

  @ManyToOne(() => Category, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'categoryId' })
  category: Category;

  @Index()
  @Column({ nullable: true })
  skinTypeId: string;

  @ManyToOne(() => SkinType, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'skinTypeId' })
  skinType: SkinType;

  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: number;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
