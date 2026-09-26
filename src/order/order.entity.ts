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
import { PickupLocation } from '../pickup-location/pickup-location.entity.js';

export type OrderStatus =
  | 'awaiting_payment'
  | 'payment_submitted'
  | 'pending'
  | 'confirmed'
  | 'delivered'
  | 'cancelled';

/** Money collected vs order total (fulfilment status stays separate). */
export type PaymentStage = 'unpaid' | 'partial' | 'full';

export type FulfilmentType = 'delivery' | 'pickup';

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

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  deliveryLat: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  deliveryLon: number | null;

  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  deliveryDistanceKm: number | null;

  @Index()
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: OrderStatus;

  /** True when stock was decremented at order create time. */
  @Column({ type: 'boolean', default: false })
  stockReserved: boolean;

  @Column({ type: 'varchar', length: 20, default: 'delivery' })
  fulfilmentType: FulfilmentType;

  /** Only set when fulfilmentType = 'pickup' */
  @Column({ nullable: true })
  pickupLocationId: string | null;

  @ManyToOne(() => PickupLocation, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pickupLocationId' })
  pickupLocation: PickupLocation | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  deliveryFee: number;

  /** Expected delivery/pickup date */
  @Column({ type: 'date', nullable: true })
  expectedDeliveryDate: Date | null;

  /** 50% payment amount required (advance) */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  advancePaymentAmount: number;

  /** Verified money collected so far (advance and/or balance). */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  amountPaid: number;

  /** unpaid → partial (half verified) → full */
  @Column({ type: 'varchar', length: 20, default: 'unpaid' })
  paymentStage: PaymentStage;

  /** URL to uploaded payment screenshot or reference text (advance) */
  @Column({ type: 'text', nullable: true })
  paymentEvidence: string | null;

  /** Payment method used: 'bank' | 'telebirr' */
  @Column({ type: 'varchar', length: 20, nullable: true })
  paymentMethod: string | null;

  /** When the customer clicked "I Have Paid" */
  @Column({ type: 'timestamptz', nullable: true })
  paymentSubmittedAt: Date | null;

  /** When advance (or full-at-checkout) payment was verified */
  @Column({ type: 'timestamptz', nullable: true })
  paymentVerifiedAt: Date | null;

  /** Remaining-balance payment evidence (TX or screenshot URL) */
  @Column({ type: 'text', nullable: true })
  balancePaymentEvidence: string | null;

  /** 'bank' | 'telebirr' for remaining payment */
  @Column({ type: 'varchar', length: 20, nullable: true })
  balancePaymentMethod: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  balancePaymentSubmittedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  balanceVerifiedAt: Date | null;

  /** Verify.ET automated verification request ID */
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  verifyEtRequestId: string | null;

  /** Verify.ET verification outcome */
  @Column({ type: 'varchar', length: 30, nullable: true })
  verifyEtStatus: string | null;

  /** Full Verify.ET response for audit */
  @Column({ type: 'jsonb', nullable: true })
  verifyEtRawResponse: Record<string, unknown> | null;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true })
  balanceVerifyEtRequestId: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  balanceVerifyEtStatus: string | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
