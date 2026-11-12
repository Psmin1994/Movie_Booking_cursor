import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class ProfileResponseDto {
  @ApiProperty({ type: String, example: "550e8400-e29b-41d4-a716-446655440000" })
  id!: string;

  @ApiProperty({ type: String, example: "user@example.com" })
  email!: string;

  @ApiProperty({ type: String, example: "홍길동" })
  name!: string;

  @ApiProperty({ type: String, example: "2026-08-19T03:00:00.000Z" })
  createdAt!: string;
}
