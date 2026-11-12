/**
 * Test Intent:
 * 애플리케이션이 만드는 OpenAPI 문서가 인증, 영화, 상영, 예매 API와 응답 스키마를 포함함을 보장한다. 예매 생성 응답은 id만 요구한다. 결제 승인 200 응답은 PAID, FAILED, RECONCILIATION_REQUIRED 스키마의 oneOf이다.
 */

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { buildOpenApiDocument } from "../src/swagger/swagger.config.js";

describe("buildOpenApiDocument", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("generates OpenAPI 3 document with API metadata", () => {
    const document = buildOpenApiDocument(app);

    expect(document.openapi).toBe("3.0.0");
    expect(document.info.title).toBe("Movie Booking API");
    expect(document.paths["/api/health"]?.get).toBeDefined();
    expect(document.paths["/api/auth/signup"]?.post).toBeDefined();
    expect(document.paths["/api/auth/login"]?.post).toBeDefined();
    expect(document.paths["/api/auth/logout"]?.post).toBeDefined();
    expect(document.paths["/api/auth/me"]?.get).toBeDefined();
    expect(document.paths["/api/movies"]?.get).toBeDefined();
    expect(document.paths["/api/movies/{id}"]?.get).toBeDefined();
    expect(document.paths["/api/screenings"]?.post).toBeDefined();
    expect(document.paths["/api/screenings/{id}"]?.get).toBeDefined();
    expect(document.paths["/api/bookings"]?.get).toBeDefined();
    expect(document.paths["/api/bookings"]?.post).toBeDefined();
    expect(document.components?.schemas?.HealthResponseDto).toBeDefined();
    expect(document.components?.schemas?.ProfileResponseDto).toBeDefined();
    expect(document.components?.schemas?.MovieSummaryResponseDto).toBeDefined();
    expect(document.components?.schemas?.MovieDetailResponseDto).toBeDefined();
    expect(document.components?.schemas?.MovieResponseDto).toBeUndefined();
    expect(document.paths["/api/movies"]?.get?.responses?.["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "array",
            items: { $ref: "#/components/schemas/MovieSummaryResponseDto" },
          },
        },
      },
    });
    expect(document.paths["/api/movies/{id}"]?.get?.responses?.["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MovieDetailResponseDto" },
        },
      },
    });
    expect(document.components?.schemas?.CreateScreeningDto).toBeDefined();
    expect(document.components?.schemas?.ScreeningResponseDto).toBeDefined();
    expect(document.components?.schemas?.GetScreeningResponseDto).toBeDefined();
    expect(document.components?.schemas?.GetMyBookingResponseDto).toBeDefined();
    expect(document.components?.schemas?.BookingResponseDto).toBeDefined();
    expect(document.components?.schemas?.GetBookingDetailResponseDto).toBeDefined();

    const createBookingResponse = document.components?.schemas?.BookingResponseDto;
    expect(createBookingResponse).toMatchObject({
      required: ["id"],
    });
    if (
      createBookingResponse &&
      "properties" in createBookingResponse &&
      createBookingResponse.properties
    ) {
      expect(Object.keys(createBookingResponse.properties)).toEqual(["id"]);
    }

    const bookingDetail = document.components?.schemas?.GetBookingDetailResponseDto;
    expect(bookingDetail).toMatchObject({
      required: expect.arrayContaining(["payment"]),
    });
    if (bookingDetail && "properties" in bookingDetail && bookingDetail.properties) {
      expect(bookingDetail.properties.payment).toBeDefined();
    }
  });

  it("documents payment approval as three terminal responses", () => {
    const document = buildOpenApiDocument(app);
    const pay = document.paths["/api/payments/{paymentId}"]?.post;
    const ok = pay?.responses?.["200"];

    expect(ok).toMatchObject({
      content: {
        "application/json": {
          schema: {
            oneOf: [
              { $ref: "#/components/schemas/PaymentResponseDto" },
              { $ref: "#/components/schemas/FailedPaymentResponseDto" },
              { $ref: "#/components/schemas/ReconciliationRequiredPaymentResponseDto" },
            ],
          },
        },
      },
    });
    expect(pay?.description).toBe(
      "승인은 PAID, FAILED, RECONCILIATION_REQUIRED 중 하나의 최종 상태로 응답한다. PAID는 paidAt을, FAILED는 failedAt을 포함한다. RECONCILIATION_REQUIRED는 기한까지 승인 결과를 확정하지 못한 상태이다.",
    );
    expect(pay?.description).not.toContain("AUTHORIZING");
    expect(document.components?.schemas?.AuthorizingPaymentResponseDto).toBeUndefined();

    const reconciliation = document.components?.schemas?.ReconciliationRequiredPaymentResponseDto;
    expect(reconciliation).toMatchObject({
      required: ["id", "bookingId", "status"],
      properties: {
        id: { type: "string" },
        bookingId: { type: "string" },
        status: { type: "string", example: "RECONCILIATION_REQUIRED" },
      },
    });
    if (reconciliation && "properties" in reconciliation && reconciliation.properties) {
      expect(Object.keys(reconciliation.properties)).toEqual(["id", "bookingId", "status"]);
    }

    const conflict = pay?.responses?.["409"];
    expect(conflict).toMatchObject({
      description:
        "결제할 수 없는 상태입니다. 또는 결제 가능 시간이 만료되었습니다. 응답 본문에는 최종 Payment 상태가 포함되지 않습니다.",
    });
    expect(conflict).not.toHaveProperty("content");
  });
});
