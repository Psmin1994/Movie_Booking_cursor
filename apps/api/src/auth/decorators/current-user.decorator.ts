import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request & {
      user?: AuthenticatedUser;
    }>();

    if (!request.user) {
      throw new UnauthorizedException("인증이 필요합니다.");
    }

    return request.user;
  },
);
