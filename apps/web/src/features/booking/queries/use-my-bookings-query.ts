import { useQuery } from "@tanstack/react-query";
import { getMyBookings } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

export function useMyBookingsQuery() {
  return useQuery({
    queryKey: queryKeys.myBookings,
    queryFn: async ({ signal }) => {
      try {
        const response = await getMyBookings({ signal });
        if (response.status !== 200) {
          throw new Error("예매 목록을 불러오지 못했습니다.");
        }
        return response.data;
      } catch (error) {
        rethrowApiError(error, "예매 목록을 불러오는 중 오류가 발생했습니다.");
      }
    },
  });
}
