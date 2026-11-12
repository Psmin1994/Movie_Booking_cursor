import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class HealthResponseDto {
  @ApiProperty({ type: String, example: "ok" })
  status!: string;

  @ApiProperty({ type: String, example: "movie-booking-api" })
  service!: string;
}
