import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class GetScreeningSeatsSeatDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440010" })
  id!: string;

  @ApiProperty({ type: String, example: "A" })
  row!: string;

  @ApiProperty({ type: Number, example: 1 })
  number!: number;

  @ApiProperty({ type: String, example: "AVAILABLE" })
  status!: string;
}

export class GetScreeningSeatsResponseDto {
  @ApiProperty({ type: GetScreeningSeatsSeatDto, isArray: true })
  seats!: GetScreeningSeatsSeatDto[];
}
