import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class CreatePaymentResponseDto {
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
}
