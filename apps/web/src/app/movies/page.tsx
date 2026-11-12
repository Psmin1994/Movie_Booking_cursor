import type { MovieSummaryResponseDto } from "@movie-booking/api-client";
import { getMovies } from "@/lib/api/server-request";
import Link from "next/link";

export default async function MoviesPage() {
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
      <h1>영화 목록</h1>
      {movies ? (
        movies.length > 0 ? (
          <section className="movie-list">
            {movies.map((movie) => (
              <article key={movie.id} className="movie-card">
                {movie.posterUrl ? (
                  <img
                    className="movie-poster"
                    src={movie.posterUrl}
                    alt={movie.title}
                  />
                ) : null}
                <h2>
                  <Link href={`/movies/${movie.id}`}>{movie.title}</Link>
                </h2>
              </article>
            ))}
          </section>
        ) : (
          <p>등록된 영화가 없습니다.</p>
        )
      ) : (
        <p className="form-error">API 서버에 연결할 수 없습니다.</p>
      )}
    </main>
  );
}
