import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GetBookingDetailResponseDto } from "@movie-booking/api-client";
import { cancelBooking } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

export function useCancelConfirmedBookingMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (bookingId: string) => {
      try {
        const response = await cancelBooking(bookingId);
        if (response.status !== 204) {
          throw new Error("예매 취소에 실패했습니다.");
        }
      } catch (error) {
        rethrowApiError(error, "예매 취소 중 오류가 발생했습니다.");
      }
    },
    onSettled: (_result, _error, bookingId) => {
      const booking = queryClient.getQueryData<GetBookingDetailResponseDto>(
        queryKeys.bookingDetail(bookingId),
      );

      void queryClient.invalidateQueries({
        queryKey: queryKeys.bookingDetail(bookingId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.myBookings,
      });

      if (booking) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.screeningSeats(booking.screening.id),
        });
      }
    },
  });
}
