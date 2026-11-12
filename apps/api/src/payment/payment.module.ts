import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { BookingModule } from "../booking/booking.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { RefundModule } from "../refund/refund.module.js";
import { CreatePaymentService } from "./use-case/create-payment.service.js";
import { ExpirePaymentScheduler } from "./scheduler/expire-payment.scheduler.js";
import { ExpirePaymentService } from "./use-case/expire-payment.service.js";
import { PaymentGatewayModule } from "./gateway/payment-gateway.module.js";
import { PaymentController } from "./controller/payment.controller.js";
import { PaymentRepository } from "./repository/payment.repository.js";
import { ReconcilePaymentRepository } from "./repository/reconcile-payment.repository.js";
import { PaymentService } from "./use-case/payment.service.js";
import { ReconcilePaymentService } from "./use-case/reconcile-payment.service.js";
import { RecoverAuthorizingPaymentScheduler } from "./scheduler/recover-authorizing-payment.scheduler.js";
import { RecoverAuthorizingPaymentService } from "./use-case/recover-authorizing-payment.service.js";
import { ReconcilePaymentScheduler } from "./scheduler/reconcile-payment.scheduler.js";

@Module({
  imports: [DatabaseModule, AuthModule, BookingModule, PaymentGatewayModule, RefundModule],
  controllers: [PaymentController],
  providers: [
    CreatePaymentService,
    ExpirePaymentScheduler,
    ExpirePaymentService,
    PaymentService,
    PaymentRepository,
    ReconcilePaymentRepository,
    ReconcilePaymentService,
    ReconcilePaymentScheduler,
    RecoverAuthorizingPaymentScheduler,
    RecoverAuthorizingPaymentService,
  ],
})
export class PaymentModule {}
