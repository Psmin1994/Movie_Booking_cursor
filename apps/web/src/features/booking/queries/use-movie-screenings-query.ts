import { useQuery } from "@tanstack/react-query";
import { getMovieScreenings } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";
import { queryKeys } from "@/lib/query/keys";

export function useMovieScreeningsQuery(
  movieId: string | null,
  date: string | null,
) {
  return useQuery({
    queryKey: queryKeys.movieScreenings(movieId, date),
    enabled: movieId !== null && date !== null,
    queryFn: async ({ signal }) => {
      if (movieId === null || date === null) {
        throw new Error("영화와 날짜를 선택해야 합니다.");
      }

      try {
        const response = await getMovieScreenings(movieId, { date }, { signal });
        if (response.status !== 200) {
          throw new Error("상영 정보를 불러오지 못했습니다.");
        }
        return response.data;
      } catch (error) {
        rethrowApiError(error, "상영 정보를 불러오는 중 오류가 발생했습니다.");
      }
    },
  });
}
