import {
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcrypt";
import type { Response } from "express";
import { ACCESS_TOKEN_COOKIE } from "../auth.constants.js";
import type { AuthenticatedUser } from "../decorators/current-user.decorator.js";
import { LoginDto } from "../dto/login.dto.js";
import { MessageResponseDto } from "../dto/message-response.dto.js";
import { ProfileResponseDto } from "../dto/profile-response.dto.js";
import { SignupDto } from "../dto/signup.dto.js";
import { StoredUser, UsersService } from "./users.service.js";

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async signup(dto: SignupDto): Promise<ProfileResponseDto> {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
    });

    return this.toProfileResponse(user);
  }

  async login(dto: LoginDto, response: Response): Promise<ProfileResponseDto> {
    const user = await this.usersService.findByEmail(dto.email);

    if (!user) {
      throw new UnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException("이메일 또는 비밀번호가 올바르지 않습니다.");
    }

    this.setAuthCookie(response, user);

    return this.toProfileResponse(user);
  }

  logout(response: Response): MessageResponseDto {
    response.clearCookie(ACCESS_TOKEN_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });

    return { message: "로그아웃되었습니다." };
  }

  async getProfile(user: AuthenticatedUser): Promise<ProfileResponseDto> {
    const storedUser = await this.usersService.getByIdOrFail(user.id);
    return this.toProfileResponse(storedUser);
  }

  private setAuthCookie(response: Response, user: StoredUser): void {
    const token = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    const jwtExpiresDays = this.configService.getOrThrow<number>(
      "auth.jwtExpiresDays",
    );

    response.cookie(ACCESS_TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure:
        this.configService.getOrThrow<string>("app.nodeEnv") === "production",
      path: "/",
      maxAge: jwtExpiresDays * 24 * 60 * 60 * 1000,
    });
  }

  private toProfileResponse(user: StoredUser): ProfileResponseDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
