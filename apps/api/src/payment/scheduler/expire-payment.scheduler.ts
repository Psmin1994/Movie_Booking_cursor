import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ExpirePaymentService } from "../use-case/expire-payment.service.js";
import { PaymentRepository } from "../repository/payment.repository.js";

const EXPIRE_PAYMENT_BATCH_LIMIT = 100;

@Injectable()
export class ExpirePaymentScheduler {
  private readonly logger = new Logger(ExpirePaymentScheduler.name);

  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly expirePaymentService: ExpirePaymentService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireDuePayments(): Promise<void> {
    const now = new Date(Date.now());
    const paymentIds = await this.paymentRepository.findExpiredPendingPaymentIds(
      now,
      EXPIRE_PAYMENT_BATCH_LIMIT,
    );

    for (const paymentId of paymentIds) {
      try {
        await this.expirePaymentService.execute(paymentId);
      } catch (error) {
        const stack = error instanceof Error ? error.stack : String(error);
        this.logger.error(`Failed to expire payment ${paymentId}`, stack);
      }
    }
  }
}
