import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class MovieDetailResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440000" })
  id!: string;

  @ApiProperty({ type: String, example: "Inception" })
  title!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      "A thief who infiltrates dreams is offered a chance to have his criminal record erased if he can implant an idea in a target's mind.",
  })
  description!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "https://example.com/posters/inception.jpg",
  })
  posterUrl!: string | null;

  @ApiProperty({ type: Number, example: 148 })
  runtime!: number;

  @ApiProperty({ type: String, example: "2010-07-16" })
  releaseDate!: string;
}
