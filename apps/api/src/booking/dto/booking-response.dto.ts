import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class BookingPaymentRefundResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440040" })
  id!: string;

  @ApiProperty({ type: Number, example: 10000 })
  amount!: number;

  @ApiProperty({ type: String, example: "PENDING" })
  status!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: null,
  })
  completedAt!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: null,
  })
  failedAt!: string | null;
}

export class BookingPaymentResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440030" })
  id!: string;

  @ApiProperty({
    type: String,
    example: "ord_550e8400-e29b-41d4-a716-446655440030",
  })
  orderId!: string;

  @ApiProperty({ type: Number, example: 10000 })
  amount!: number;

  @ApiProperty({ type: String, example: "PENDING" })
  status!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: null,
  })
  paidAt!: string | null;

  @ApiProperty({ type: BookingPaymentRefundResponseDto, isArray: true })
  refunds!: BookingPaymentRefundResponseDto[];
}

export class BookingResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440020" })
  id!: string;
}
