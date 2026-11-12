import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class PayPaymentDto {
  @ApiProperty({ type: String, example: "toss_payment_key" })
  @IsString()
  @IsNotEmpty()
  paymentKey!: string;
}
