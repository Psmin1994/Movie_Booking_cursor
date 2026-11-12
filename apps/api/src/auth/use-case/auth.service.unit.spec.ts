/**
 * Test Intent:
 * 회원가입과 로그인은 올바른 자격일 때만 사용자를 인증하고, 프로필은 인증된 사용자만 조회할 수 있음을 보장한다. 중복 이메일과 잘못된 비밀번호는 거절되고, 로그아웃은 인증을 끝낸다.
 */

import { jest } from "@jest/globals";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import bcrypt from "bcrypt";
import type { Response } from "express";
import { AuthService } from "./auth.service.js";
import { StoredUser, UsersService } from "./users.service.js";

const USER_ID = "550e8400-e29b-41d4-a716-446655440000";
const CREATED_AT = new Date("2026-09-20T10:30:00.000Z");
const SIGNUP_DTO = {
  email: "user@example.com",
  password: "password123",
  name: "홍길동",
};

type UsersServiceMocks = {
  create: jest.MockedFunction<UsersService["create"]>;
  findByEmail: jest.MockedFunction<UsersService["findByEmail"]>;
  getByIdOrFail: jest.MockedFunction<UsersService["getByIdOrFail"]>;
};

function createStoredUser(overrides?: Partial<StoredUser>): StoredUser {
  return {
    id: USER_ID,
    email: "user@example.com",
    passwordHash: "hashed-password",
    name: "홍길동",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("AuthService", () => {
  let authService: AuthService;
  let usersService: UsersServiceMocks;

  beforeEach(async () => {
    usersService = {
      create: jest.fn<UsersService["create"]>(),
      findByEmail: jest.fn<UsersService["findByEmail"]>(),
      getByIdOrFail: jest.fn<UsersService["getByIdOrFail"]>(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: "test-secret",
          signOptions: { expiresIn: "7d" },
        }),
      ],
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: usersService,
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              switch (key) {
                case "app.nodeEnv":
                  return "development";
                case "auth.jwtExpiresDays":
                  return 7;
                default:
                  throw new Error(`Unexpected config key: ${key}`);
              }
            },
          },
        },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  it("creates a user on signup", async () => {
    const storedUser = createStoredUser();
    usersService.create.mockResolvedValue(storedUser);

    const profile = await authService.signup(SIGNUP_DTO);

    expect(usersService.create).toHaveBeenCalledWith({
      email: SIGNUP_DTO.email,
      passwordHash: expect.any(String),
      name: SIGNUP_DTO.name,
    });
    expect(profile).toEqual({
      id: USER_ID,
      email: "user@example.com",
      name: "홍길동",
      createdAt: CREATED_AT.toISOString(),
    });
  });

  it("rejects duplicate signup email", async () => {
    usersService.create.mockRejectedValue(
      new ConflictException("이미 사용 중인 이메일입니다."),
    );

    await expect(authService.signup(SIGNUP_DTO)).rejects.toThrow(
      ConflictException,
    );
  });

  it("logs in with valid credentials and sets auth cookie", async () => {
    const passwordHash = await bcrypt.hash("password123", 10);
    usersService.findByEmail.mockResolvedValue(
      createStoredUser({ passwordHash }),
    );

    const cookie = jest.fn();
    const response = { cookie } as unknown as Response;

    const profile = await authService.login(
      {
        email: "user@example.com",
        password: "password123",
      },
      response,
    );

    expect(profile.email).toBe("user@example.com");
    expect(cookie).toHaveBeenCalledWith(
      "access_token",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      }),
    );
  });

  it("rejects invalid login credentials", async () => {
    const passwordHash = await bcrypt.hash("password123", 10);
    usersService.findByEmail.mockResolvedValue(
      createStoredUser({ passwordHash }),
    );

    const response = { cookie: jest.fn() } as unknown as Response;

    await expect(
      authService.login(
        {
          email: "user@example.com",
          password: "wrong-password",
        },
        response,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("returns profile for authenticated user", async () => {
    const storedUser = createStoredUser();
    usersService.getByIdOrFail.mockResolvedValue(storedUser);

    const profile = await authService.getProfile({
      id: storedUser.id,
      email: storedUser.email,
    });

    expect(usersService.getByIdOrFail).toHaveBeenCalledWith(storedUser.id);
    expect(profile).toEqual({
      id: storedUser.id,
      email: storedUser.email,
      name: storedUser.name,
      createdAt: storedUser.createdAt.toISOString(),
    });
  });

  it("clears auth cookie on logout", () => {
    const clearCookie = jest.fn();
    const response = { clearCookie } as unknown as Response;

    const result = authService.logout(response);

    expect(result).toEqual({ message: "로그아웃되었습니다." });
    expect(clearCookie).toHaveBeenCalledWith(
      "access_token",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      }),
    );
  });
});
