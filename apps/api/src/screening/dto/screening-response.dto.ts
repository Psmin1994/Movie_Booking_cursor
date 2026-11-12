import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class ScreeningResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440002" })
  id!: string;

  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440000" })
  movieId!: string;

  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440001" })
  screenId!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T10:30:00.000Z",
  })
  startAt!: string;
}
