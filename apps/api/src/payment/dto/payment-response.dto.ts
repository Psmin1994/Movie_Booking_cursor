import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class PaymentResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440030" })
  id!: string;

  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440020" })
  bookingId!: string;

  @ApiProperty({ type: String, example: "PAID" })
  status!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-24T10:30:00.000Z",
  })
  paidAt!: string;
}
