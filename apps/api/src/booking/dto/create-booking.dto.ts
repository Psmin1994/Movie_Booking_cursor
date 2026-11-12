import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsUUID,
} from "class-validator";

export class CreateBookingDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440002" })
  @IsUUID()
  screeningId!: string;

  @ApiProperty({
    type: String,
    isArray: true,
    example: ["550e8400-e29b-41d4-a716-446655440010"],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  screeningSeatIds!: string[];
}
