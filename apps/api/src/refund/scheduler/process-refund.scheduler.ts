import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import {
  PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
  PROCESS_REFUND_SCHEDULER_CRON,
  PROCESS_REFUND_SCHEDULER_TIMEZONE,
} from "../refund.constants.js";
import { RefundRepository } from "../repository/refund.repository.js";
import { ProcessRefundService } from "../use-case/process-refund.service.js";

@Injectable()
export class ProcessRefundScheduler {
  private readonly logger = new Logger(ProcessRefundScheduler.name);

  constructor(
    private readonly refundRepository: RefundRepository,
    private readonly processRefundService: ProcessRefundService,
  ) {}

  @Cron(PROCESS_REFUND_SCHEDULER_CRON, {
    timeZone: PROCESS_REFUND_SCHEDULER_TIMEZONE,
    waitForCompletion: true,
  })
  async processDueRefunds(): Promise<void> {
    const now = new Date(Date.now());
    const refundIds = await this.refundRepository.findDueRefundIds(
      now,
      PROCESS_REFUND_SCHEDULER_BATCH_LIMIT,
    );

    for (const refundId of refundIds) {
      try {
        await this.processRefundService.execute(refundId);
      } catch (error) {
        const stack = error instanceof Error ? error.stack : String(error);
        this.logger.error(`Failed to process refund ${refundId}`, stack);
      }
    }
  }
}
