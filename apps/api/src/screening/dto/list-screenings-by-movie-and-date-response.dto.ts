import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class ListScreeningsByMovieAndDateScreenDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440001" })
  id!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;

  @ApiProperty({ type: Number, example: 2 })
  floor!: number;

  @ApiProperty({ type: String, example: "IMAX" })
  screenType!: string;
}

export class ListScreeningsByMovieAndDateScreeningDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440002" })
  id!: string;

  @ApiProperty({ type: String, example: "10:00" })
  startTime!: string;
}

export class ListScreeningsByMovieAndDateScreenGroupDto {
  @ApiProperty({ type: ListScreeningsByMovieAndDateScreenDto })
  screen!: ListScreeningsByMovieAndDateScreenDto;

  @ApiProperty({ type: ListScreeningsByMovieAndDateScreeningDto, isArray: true })
  screenings!: ListScreeningsByMovieAndDateScreeningDto[];
}

export class ListScreeningsByMovieAndDateResponseDto {
  @ApiProperty({ type: String, format: "date", example: "2026-09-20" })
  date!: string;

  @ApiProperty({
    type: ListScreeningsByMovieAndDateScreenGroupDto,
    isArray: true,
  })
  screens!: ListScreeningsByMovieAndDateScreenGroupDto[];
}
