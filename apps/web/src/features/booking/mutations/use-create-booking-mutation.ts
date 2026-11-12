import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateBookingDto } from "@movie-booking/api-client";
import { createBooking } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

export function useCreateBookingMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (createBookingDto: CreateBookingDto) => {
      try {
        const response = await createBooking(createBookingDto);
        if (response.status !== 201) {
          throw new Error("예매에 실패했습니다.");
        }
        return response.data;
      } catch (error) {
        rethrowApiError(error, "예매 요청 중 오류가 발생했습니다.");
      }
    },
    onSuccess: (_booking, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.screeningSeats(variables.screeningId),
      });
    },
  });
}
