import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../database/prisma.service.js";
import {
  RECONCILE_PAYMENT_SCHEDULER_CONCURRENCY,
  RECONCILE_PAYMENT_SCHEDULER_DUE_BATCH_LIMIT,
  RECONCILE_PAYMENT_SCHEDULER_SWEEP_BATCH_LIMIT,
} from "../payment.constants.js";
import { ReconcilePaymentRepository } from "../repository/reconcile-payment.repository.js";
import { ReconcilePaymentService } from "../use-case/reconcile-payment.service.js";

@Injectable()
export class ReconcilePaymentScheduler {
  private readonly logger = new Logger(ReconcilePaymentScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconcilePaymentRepository: ReconcilePaymentRepository,
    private readonly reconcilePaymentService: ReconcilePaymentService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    waitForCompletion: true,
  })
  async processDueReconciliations(): Promise<void> {
    const now = new Date(Date.now());

    await this.sweepPastDeadline(now);

    try {
      const reconciliationIds = await this.reconcilePaymentRepository.findDueIds(
        now,
        RECONCILE_PAYMENT_SCHEDULER_DUE_BATCH_LIMIT,
      );

      await mapWithConcurrency(reconciliationIds, RECONCILE_PAYMENT_SCHEDULER_CONCURRENCY, async (reconciliationId) => {
        try {
          await this.reconcilePaymentService.execute(reconciliationId);
        } catch (error) {
          const stack = error instanceof Error ? error.stack : String(error);
          this.logger.error(`Failed to reconcile payment ${reconciliationId}`, stack);
        }
      });
    } catch (error) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error("Failed to process due reconciliations", stack);
    }

    // Refresh now so leases that expired during due processing are eligible.
    await this.sweepPastDeadline(new Date(Date.now()));
  }

  private async sweepPastDeadline(now: Date): Promise<void> {
    let reconciliationIds: string[];

    try {
      reconciliationIds = await this.reconcilePaymentRepository.findPastDeadlineIds(
        now,
        RECONCILE_PAYMENT_SCHEDULER_SWEEP_BATCH_LIMIT,
      );
    } catch (error) {
      const stack = error instanceof Error ? error.stack : String(error);
      this.logger.error("Failed to find past-deadline reconciliations", stack);
      return;
    }

    for (const reconciliationId of reconciliationIds) {
      try {
        await this.prisma.client.$transaction((tx) =>
          this.reconcilePaymentRepository.markReviewPastDeadline(tx, reconciliationId, now),
        );
      } catch (error) {
        const stack = error instanceof Error ? error.stack : String(error);
        this.logger.error(`Failed to mark past-deadline reconciliation ${reconciliationId}`, stack);
      }
    }
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      const item = items[index];
      if (item === undefined) {
        return;
      }

      await worker(item);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
}
