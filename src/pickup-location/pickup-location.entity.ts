import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('pickup_locations')
export class PickupLocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 200 })
  name: string;

  /** Text notes for customers (address landmarks, hours, how to find). */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /**
   * Legacy optional field — kept nullable for existing rows.
   * New pickups use name + description only.
   */
  @Column({ type: 'text', nullable: true, default: '' })
  address: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  lat: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  lon: number | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
