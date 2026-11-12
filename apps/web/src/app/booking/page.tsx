import type { MovieSummaryResponseDto } from "@movie-booking/api-client";
import { BookingSelector } from "@/features/booking/components/booking-selector";
import { getMovies } from "@/lib/api/server-request";

export default async function BookingPage() {
  let movies: MovieSummaryResponseDto[] | null = null;

  try {
    const response = await getMovies();
    if (response.status === 200) {
      movies = response.data;
    }
  } catch {
    movies = null;
  }

  return (
    <main>
      <h1>예매</h1>
      {movies ? (
        <BookingSelector movies={movies} />
      ) : (
        <p className="form-error">API 서버에 연결할 수 없습니다.</p>
      )}
    </main>
  );
}
