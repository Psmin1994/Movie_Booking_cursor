import { isHttpError, type MovieDetailResponseDto } from "@movie-booking/api-client";
import { getMovie } from "@/lib/api/server-request";
import { notFound } from "next/navigation";

type MovieDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function MovieDetailPage({ params }: MovieDetailPageProps) {
  const { id } = await params;
  let movie: MovieDetailResponseDto | null = null;

  try {
    const response = await getMovie(id);
    if (response.status === 200) {
      movie = response.data;
    }
  } catch (error) {
    if (isHttpError(error) && error.status === 404) {
      notFound();
    }
  }

  return (
    <main>
      <h1>영화 상세</h1>
      {movie ? (
        <article className="movie-card">
          {movie.posterUrl ? (
            <img
              className="movie-poster"
              src={movie.posterUrl}
              alt={movie.title}
            />
          ) : null}
          <h2>{movie.title}</h2>
          {movie.description ? <p>{movie.description}</p> : null}
          <dl>
            <div>
              <dt>runtime</dt>
              <dd>{movie.runtime}분</dd>
            </div>
            <div>
              <dt>releaseDate</dt>
              <dd>{movie.releaseDate}</dd>
            </div>
          </dl>
        </article>
      ) : (
        <p className="form-error">API 서버에 연결할 수 없습니다.</p>
      )}
    </main>
  );
}
