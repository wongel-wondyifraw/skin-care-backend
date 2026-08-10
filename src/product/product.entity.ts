import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
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

  /** Optional brand / manufacturer name */
  @Column({ type: 'varchar', length: 120, nullable: true })
  brand: string | null;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'text' })
  image: string;

  @Column({ type: 'varchar', nullable: true })
  assetId: string;

  @Index()
  @Column({ nullable: true })
  categoryId: string | null;

  @ManyToOne(() => Category, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'categoryId' })
  category: Category;

  /** Legacy single skin type — kept for older rows / filters */
  @Index()
  @Column({ nullable: true })
  skinTypeId: string | null;

  @ManyToOne(() => SkinType, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'skinTypeId' })
  skinType: SkinType;

  /** Preferred: one product can suit multiple skin types */
  @ManyToMany(() => SkinType, { eager: false })
  @JoinTable({
    name: 'product_skin_types',
    joinColumn: { name: 'productId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'skinTypeId', referencedColumnName: 'id' },
  })
  skinTypes: SkinType[];

  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: number;

  /** 0–100. Sale price = price * (1 - discountPercent/100). */
  @Column({ type: 'int', default: 0 })
  discountPercent: number;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
