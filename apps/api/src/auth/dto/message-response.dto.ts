import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";

export class MessageResponseDto {
  @ApiProperty({ type: String, example: "로그아웃되었습니다." })
  message!: string;
}
