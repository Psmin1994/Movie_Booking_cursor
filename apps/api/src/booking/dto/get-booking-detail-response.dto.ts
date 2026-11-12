import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";
import { BookingPaymentResponseDto } from "./booking-response.dto.js";

export class GetBookingDetailMovieDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440000" })
  id!: string;

  @ApiProperty({ type: String, example: "Inception" })
  title!: string;
}

export class GetBookingDetailScreeningDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440002" })
  id!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T01:00:00.000Z",
  })
  startAt!: string;
}

export class GetBookingDetailScreenDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440001" })
  id!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;

  @ApiProperty({ type: Number, example: 2 })
  floor!: number;

  @ApiProperty({ type: String, example: "IMAX" })
  screenType!: string;
}

export class GetBookingDetailSeatDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440010" })
  id!: string;

  @ApiProperty({ type: String, example: "A" })
  row!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;
}

export class GetBookingDetailResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440020" })
  id!: string;

  @ApiProperty({ type: String, example: "CONFIRMED" })
  status!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T10:30:00.000Z",
  })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-20T10:40:00.000Z",
  })
  expiresAt!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-20T10:30:00.000Z",
  })
  confirmedAt!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: null,
  })
  cancelledAt!: string | null;

  @ApiProperty({ type: GetBookingDetailMovieDto })
  movie!: GetBookingDetailMovieDto;

  @ApiProperty({ type: GetBookingDetailScreeningDto })
  screening!: GetBookingDetailScreeningDto;

  @ApiProperty({ type: GetBookingDetailScreenDto })
  screen!: GetBookingDetailScreenDto;

  @ApiProperty({ type: GetBookingDetailSeatDto, isArray: true })
  seats!: GetBookingDetailSeatDto[];

  @ApiProperty({ type: BookingPaymentResponseDto, nullable: true })
  payment!: BookingPaymentResponseDto | null;
}
