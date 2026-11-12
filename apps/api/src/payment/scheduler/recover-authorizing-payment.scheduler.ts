import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PaymentRepository } from "../repository/payment.repository.js";
import { RecoverAuthorizingPaymentService } from "../use-case/recover-authorizing-payment.service.js";

const RECOVER_AUTHORIZING_PAYMENT_BATCH_LIMIT = 100;

// 결제 요청 시간이 만료된 결제를 조회하고, 결제 상태를 업데이트하는 스케줄러
@Injectable()
export class RecoverAuthorizingPaymentScheduler {
  private readonly logger = new Logger(RecoverAuthorizingPaymentScheduler.name);

  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly recoverAuthorizingPaymentService: RecoverAuthorizingPaymentService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverDueAuthorizingPayments(): Promise<void> {
    const now = new Date(Date.now());
    const paymentIds = await this.paymentRepository.findAuthorizingPaymentIdsPastDeadline(
      now,
      RECOVER_AUTHORIZING_PAYMENT_BATCH_LIMIT,
    );

    for (const paymentId of paymentIds) {
      try {
        await this.recoverAuthorizingPaymentService.execute(paymentId);
      } catch (error) {
        const stack = error instanceof Error ? error.stack : String(error);
        this.logger.error(`Failed to recover authorizing payment ${paymentId}`, stack);
      }
    }
  }
}
