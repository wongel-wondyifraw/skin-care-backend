import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AdminNotificationType =
  | 'order_placed'
  | 'order_cancelled'
  | 'order_delivered';

@Entity('admin_notifications')
export class AdminNotification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 40 })
  type: AdminNotificationType;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @Column({ type: 'varchar', length: 400 })
  body: string;

  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  /** Frontend path, e.g. /admin/orders */
  @Column({ type: 'varchar', length: 200, default: '/admin/orders' })
  href: string;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
