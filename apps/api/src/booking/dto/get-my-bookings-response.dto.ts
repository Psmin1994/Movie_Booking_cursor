import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class GetMyBookingMovieDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440000" })
  id!: string;

  @ApiProperty({ type: String, example: "Inception" })
  title!: string;
}

export class GetMyBookingScreeningDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440002" })
  id!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T01:00:00.000Z",
  })
  startAt!: string;
}

export class GetMyBookingScreenDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440001" })
  id!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;

  @ApiProperty({ type: Number, example: 2 })
  floor!: number;

  @ApiProperty({ type: String, example: "IMAX" })
  screenType!: string;
}

export class GetMyBookingSeatDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440010" })
  id!: string;

  @ApiProperty({ type: String, example: "A" })
  row!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;
}

export class GetMyBookingResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440020" })
  id!: string;

  @ApiProperty({ type: String, example: "CONFIRMED" })
  status!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-20T10:30:00.000Z",
  })
  confirmedAt!: string | null;

  @ApiProperty({ type: GetMyBookingMovieDto })
  movie!: GetMyBookingMovieDto;

  @ApiProperty({ type: GetMyBookingScreeningDto })
  screening!: GetMyBookingScreeningDto;

  @ApiProperty({ type: GetMyBookingScreenDto })
  screen!: GetMyBookingScreenDto;

  @ApiProperty({ type: GetMyBookingSeatDto, isArray: true })
  seats!: GetMyBookingSeatDto[];
}
