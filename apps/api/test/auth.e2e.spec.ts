/**
 * Test Intent:
 * 회원가입, 로그인, 쿠키로 이어지는 프로필 조회, 로그아웃이 HTTP에서 이어짐을 보장한다.
 * 로그인만 access_token 쿠키를 발급하고, 로그아웃은 그 쿠키를 제거한다.
 * 중복 이메일과 잘못된 비밀번호는 거절되며, 응답에 비밀번호가 포함되지 않는다.
 */

import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import request from "supertest";
import { PrismaService } from "../src/database/prisma.service.js";
import { createTestApp } from "./helpers/create-test-app.js";

describe("Auth (e2e)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    if (!prisma || createdEmails.length === 0) {
      return;
    }

    const emails = [...createdEmails];
    createdEmails.length = 0;
    await prisma.client.user.deleteMany({
      where: { email: { in: emails } },
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  function uniqueEmail(): string {
    const email = `auth-${randomUUID()}@example.com`;
    createdEmails.push(email);
    return email;
  }

  it("supports signup, login, profile lookup, and logout", async () => {
    const email = uniqueEmail();

    const signupResponse = await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email,
        password: "password123",
        name: "홍길동",
      })
      .expect(201);

    expect(signupResponse.body).toMatchObject({
      id: expect.any(String),
      email,
      name: "홍길동",
    });
    expectNoSecret(signupResponse.body);
    expect(signupResponse.headers["set-cookie"]).toBeUndefined();

    const loginResponse = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({
        email,
        password: "password123",
      })
      .expect(200);

    expect(loginResponse.body).toMatchObject({
      id: signupResponse.body.id,
      email,
      name: "홍길동",
    });
    expectNoSecret(loginResponse.body);

    const cookie = loginResponse.headers["set-cookie"];
    expect(cookie).toBeDefined();
    expect(cookie?.[0]).toContain("access_token=");

    const profileResponse = await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", cookie)
      .expect(200);

    expect(profileResponse.body).toMatchObject({
      id: signupResponse.body.id,
      email,
      name: "홍길동",
    });
    expectNoSecret(profileResponse.body);

    await request(app.getHttpServer()).get("/api/auth/me").expect(401);

    const logoutResponse = await request(app.getHttpServer())
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .expect(200);

    expect(logoutResponse.body).toEqual({
      message: "로그아웃되었습니다.",
    });
    expect(clearedAccessToken(logoutResponse.headers["set-cookie"])).toBe(
      "access_token=",
    );
  });

  it("rejects duplicate signup email", async () => {
    const email = uniqueEmail();

    await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email,
        password: "password123",
        name: "홍길동",
      })
      .expect(201);

    await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email,
        password: "password456",
        name: "김철수",
      })
      .expect(409);
  });

  it("rejects invalid login credentials", async () => {
    const email = uniqueEmail();

    await request(app.getHttpServer())
      .post("/api/auth/signup")
      .send({
        email,
        password: "password123",
        name: "홍길동",
      })
      .expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({
        email,
        password: "wrong-password",
      })
      .expect(401);

    expect(loginResponse.headers["set-cookie"]).toBeUndefined();
    expectNoSecret(loginResponse.body);
  });
});

function expectNoSecret(body: object): void {
  expect(body).not.toHaveProperty("password");
  expect(body).not.toHaveProperty("passwordHash");
}

function clearedAccessToken(
  setCookie: string | string[] | undefined,
): string | undefined {
  const cookies =
    setCookie == null ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  const accessToken = cookies.find((cookie) =>
    cookie.startsWith("access_token="),
  );

  return accessToken?.split(";")[0];
}
