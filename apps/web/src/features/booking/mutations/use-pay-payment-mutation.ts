import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  FailedPaymentResponseDto,
  PaymentControllerPay200,
  PaymentResponseDto,
  ReconciliationRequiredPaymentResponseDto,
} from "@movie-booking/api-client";
import { payPayment } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

export type PayPaymentVariables = {
  paymentId: string;
  paymentKey: string;
  bookingId: string;
};

function isPaymentRecord(data: unknown): data is {
  id: string;
  bookingId: string;
  status: string;
} {
  return (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    typeof data.id === "string" &&
    "bookingId" in data &&
    typeof data.bookingId === "string" &&
    "status" in data &&
    typeof data.status === "string"
  );
}

function isPaidPayment(data: unknown): data is PaymentResponseDto {
  return (
    isPaymentRecord(data) &&
    data.status === "PAID" &&
    "paidAt" in data &&
    typeof data.paidAt === "string"
  );
}

function isFailedPayment(data: unknown): data is FailedPaymentResponseDto {
  return (
    isPaymentRecord(data) &&
    data.status === "FAILED" &&
    "failedAt" in data &&
    typeof data.failedAt === "string"
  );
}

function isReconciliationRequiredPayment(
  data: unknown,
): data is ReconciliationRequiredPaymentResponseDto {
  return isPaymentRecord(data) && data.status === "RECONCILIATION_REQUIRED";
}

function payResult(data: unknown): PaymentControllerPay200 | null {
  if (
    isPaidPayment(data) ||
    isFailedPayment(data) ||
    isReconciliationRequiredPayment(data)
  ) {
    return data;
  }

  return null;
}

export function usePayPaymentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ paymentId, paymentKey }: PayPaymentVariables) => {
      let response;

      try {
        response = await payPayment(paymentId, { paymentKey });
      } catch (error) {
        rethrowApiError(error, "결제 승인 요청 중 오류가 발생했습니다.");
      }

      if (response.status !== 200) {
        throw new Error("결제 승인에 실패했습니다.");
      }

      const result = payResult(response.data);
      if (result) {
        return result;
      }

      throw new Error("결제 승인에 실패했습니다.");
    },
    onSettled: (_payment, _error, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bookingDetail(variables.bookingId),
      });
    },
  });
}
