/**
 * Test Intent:
 * HTTP GET /api/openapi.json이 생성된 OpenAPI 3 문서와 상태 확인 응답 스키마를 반환함을 보장한다.
 */

import { INestApplication } from "@nestjs/common";
import { App } from "supertest/types";
import request from "supertest";
import { createTestApp } from "./helpers/create-test-app.js";

describe("OpenAPI HTTP document", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/openapi.json returns OpenAPI 3 document", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/openapi.json")
      .expect(200)
      .expect("Content-Type", /json/);

    expect(response.body.openapi).toBe("3.0.0");
    expect(response.body.info).toMatchObject({
      title: "Movie Booking API",
      description: "영화 예매 서비스 API",
      version: "1.0.0",
    });
  });

  it("includes documented health endpoint and response schema", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/openapi.json")
      .expect(200);

    const healthPath = response.body.paths["/api/health"];
    expect(healthPath?.get).toMatchObject({
      summary: "서비스 상태 확인",
      tags: ["health"],
    });

    const healthSchema =
      healthPath?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(healthSchema).toEqual({
      $ref: "#/components/schemas/HealthResponseDto",
    });

    expect(response.body.components.schemas.HealthResponseDto).toMatchObject({
      type: "object",
      required: ["status", "service"],
      properties: {
        status: { type: "string", example: "ok" },
        service: { type: "string", example: "movie-booking-api" },
      },
    });
  });
});
