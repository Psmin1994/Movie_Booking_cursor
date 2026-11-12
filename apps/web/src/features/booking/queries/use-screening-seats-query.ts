import { useQuery } from "@tanstack/react-query";
import { getScreeningSeats } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

export function useScreeningSeatsQuery(screeningId: string) {
  return useQuery({
    queryKey: queryKeys.screeningSeats(screeningId),
    queryFn: async ({ signal }) => {
      try {
        const response = await getScreeningSeats(screeningId, { signal });
        if (response.status !== 200) {
          throw new Error("좌석 정보를 불러오지 못했습니다.");
        }
        return response.data;
      } catch (error) {
        rethrowApiError(error, "좌석 정보를 불러오는 중 오류가 발생했습니다.");
      }
    },
  });
}
