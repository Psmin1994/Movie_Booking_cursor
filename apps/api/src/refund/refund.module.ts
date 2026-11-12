import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { PaymentGatewayModule } from "../payment/gateway/payment-gateway.module.js";
import { RefundRepository } from "./repository/refund.repository.js";
import { ProcessRefundScheduler } from "./scheduler/process-refund.scheduler.js";
import { ProcessRefundService } from "./use-case/process-refund.service.js";

@Module({
  imports: [DatabaseModule, PaymentGatewayModule],
  providers: [ProcessRefundService, ProcessRefundScheduler, RefundRepository],
  exports: [RefundRepository, ProcessRefundService],
})
export class RefundModule {}
