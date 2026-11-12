import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isHttpError, type CreatePaymentDto } from "@movie-booking/api-client";
import { createPayment } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

const PAYMENT_ALREADY_CREATED_MESSAGE = "이미 결제가 생성된 예매입니다.";

function isPaymentAlreadyCreated(error: unknown): boolean {
  return (
    isHttpError(error) &&
    error.status === 409 &&
    error.message === PAYMENT_ALREADY_CREATED_MESSAGE
  );
}

export function useCreatePaymentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (createPaymentDto: CreatePaymentDto) => {
      try {
        const response = await createPayment(createPaymentDto);
        if (response.status !== 201) {
          throw new Error("결제 생성에 실패했습니다.");
        }
        return response.data;
      } catch (error) {
        rethrowApiError(error, "결제 요청 중 오류가 발생했습니다.");
      }
    },
    onSuccess: (_payment, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.bookingDetail(variables.bookingId),
      });
    },
    onError: (error, variables) => {
      if (!isPaymentAlreadyCreated(error)) {
        return;
      }

      void queryClient.invalidateQueries({
        queryKey: queryKeys.bookingDetail(variables.bookingId),
      });
    },
  });
}
