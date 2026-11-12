/**
 * Test Intent:
 * Payment 모듈은 기한이 지난 AUTHORIZING Payment를 PG 조회 없이 복구하도록 등록한다. AUTHORIZING을 PG에 주기 조회하지 않고, Booking hold가 끝난 PENDING Payment의 만료 스케줄러는 유지된다. 대사 대상 조회 스케줄러는 등록하지 않는다.
 */

import { ExpirePaymentScheduler } from "./scheduler/expire-payment.scheduler.js";
import { PaymentModule } from "./payment.module.js";
import { RecoverAuthorizingPaymentScheduler } from "./scheduler/recover-authorizing-payment.scheduler.js";

describe("PaymentModule", () => {
  it("registers authorizing recovery without a payment-gateway retrieve schedule", () => {
    const providers = Reflect.getMetadata("providers", PaymentModule) as unknown[];
    const names = providers.map((provider) => (typeof provider === "function" ? provider.name : undefined));

    expect(names).toContain(ExpirePaymentScheduler.name);
    expect(names).toContain(RecoverAuthorizingPaymentScheduler.name);
    expect(names).not.toContain("FindDuePaymentReconciliationScheduler");
    expect(names).not.toContain("ApplyAuthorizingPaymentService");
    expect(names).not.toContain("RetrieveAuthorizingPaymentService");
    expect(names).not.toContain("RetrieveAuthorizingPaymentScheduler");
  });
});
