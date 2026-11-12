import { useQuery } from "@tanstack/react-query";
import { getBookingDetail } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

export function useBookingDetailQuery(bookingId: string) {
  return useQuery({
    queryKey: queryKeys.bookingDetail(bookingId),
    queryFn: async ({ signal }) => {
      try {
        const response = await getBookingDetail(bookingId, { signal });
        if (response.status !== 200) {
          throw new Error("예매 정보를 불러오지 못했습니다.");
        }
        return response.data;
      } catch (error) {
        rethrowApiError(error, "예매 정보를 불러오는 중 오류가 발생했습니다.");
      }
    },
  });
}
