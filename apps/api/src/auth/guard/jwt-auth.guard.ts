import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { ACCESS_TOKEN_COOKIE } from "../auth.constants.js";
import type { AuthenticatedUser } from "../decorators/current-user.decorator.js";

interface AccessTokenPayload {
  sub: string;
  email: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & {
      user?: AuthenticatedUser;
    }>();
    const token = request.cookies?.[ACCESS_TOKEN_COOKIE];

    if (!token) {
      throw new UnauthorizedException("인증이 필요합니다.");
    }

    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(token);
      request.user = {
        id: payload.sub,
        email: payload.email,
      };
      return true;
    } catch {
      throw new UnauthorizedException("유효하지 않은 인증 정보입니다.");
    }
  }
}
