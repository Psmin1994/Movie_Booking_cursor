import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class MovieSummaryResponseDto {
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
}
