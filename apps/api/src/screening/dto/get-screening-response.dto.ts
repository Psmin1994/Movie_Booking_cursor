import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class GetScreeningMovieDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440000" })
  id!: string;

  @ApiProperty({ type: String, example: "Inception" })
  title!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "https://example.com/posters/inception.jpg",
  })
  posterUrl!: string | null;

  @ApiProperty({ type: Number, example: 148 })
  runtime!: number;
}

export class GetScreeningScreenDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440001" })
  id!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;

  @ApiProperty({ type: Number, example: 3 })
  floor!: number;

  @ApiProperty({ type: String, example: "IMAX" })
  screenType!: string;
}

export class GetScreeningSeatDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440010" })
  id!: string;

  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440011" })
  seatId!: string;

  @ApiProperty({ type: String, example: "A" })
  row!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;

  @ApiProperty({ type: String, example: "STANDARD" })
  seatType!: string;

  @ApiProperty({ type: String, example: "AVAILABLE" })
  status!: string;
}

export class GetScreeningResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440002" })
  id!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T10:30:00.000Z",
  })
  startAt!: string;

  @ApiProperty({ type: GetScreeningMovieDto })
  movie!: GetScreeningMovieDto;

  @ApiProperty({ type: GetScreeningScreenDto })
  screen!: GetScreeningScreenDto;

  @ApiProperty({ type: GetScreeningSeatDto, isArray: true })
  seats!: GetScreeningSeatDto[];
}
