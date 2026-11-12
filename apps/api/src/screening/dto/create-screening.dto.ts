import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";
import { IsISO8601, IsUUID } from "class-validator";

export class CreateScreeningDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440000" })
  @IsUUID()
  movieId!: string;

  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440001" })
  @IsUUID()
  screenId!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T10:30:00.000Z",
  })
  @IsISO8601()
  startAt!: string;
}
