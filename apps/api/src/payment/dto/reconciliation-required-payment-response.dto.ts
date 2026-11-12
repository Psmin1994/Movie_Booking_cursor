import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class ReconciliationRequiredPaymentResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440030" })
  id!: string;

  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440020" })
  bookingId!: string;

  @ApiProperty({ type: String, example: "RECONCILIATION_REQUIRED" })
  status!: string;
}
