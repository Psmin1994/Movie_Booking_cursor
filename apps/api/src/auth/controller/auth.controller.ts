import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiBody,
} from "@nestjs/swagger";
import type { Response } from "express";
import { AuthService } from "../use-case/auth.service.js";
import { CurrentUser } from "../decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../decorators/current-user.decorator.js";
import { LoginDto } from "../dto/login.dto.js";
import { MessageResponseDto } from "../dto/message-response.dto.js";
import { ProfileResponseDto } from "../dto/profile-response.dto.js";
import { SignupDto } from "../dto/signup.dto.js";
import { JwtAuthGuard } from "../guard/jwt-auth.guard.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("signup")
  @ApiOperation({ summary: "회원가입" })
  @ApiBody({ type: SignupDto })
  @ApiCreatedResponse({ type: ProfileResponseDto })
  @ApiConflictResponse({ description: "이미 사용 중인 이메일" })
  async signup(@Body() dto: SignupDto): Promise<ProfileResponseDto> {
    return this.authService.signup(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "로그인" })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: ProfileResponseDto })
  @ApiUnauthorizedResponse({ description: "인증 실패" })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProfileResponseDto> {
    return this.authService.login(dto, response);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "로그아웃" })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Res({ passthrough: true }) response: Response): MessageResponseDto {
    return this.authService.logout(response);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "내 정보 조회" })
  @ApiOkResponse({ type: ProfileResponseDto })
  @ApiUnauthorizedResponse({ description: "인증 필요" })
  getProfile(@CurrentUser() user: AuthenticatedUser): Promise<ProfileResponseDto> {
    return this.authService.getProfile(user);
  }
}
