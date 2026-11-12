import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class CreatePaymentDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440020" })
  @IsUUID()
  bookingId!: string;
}
