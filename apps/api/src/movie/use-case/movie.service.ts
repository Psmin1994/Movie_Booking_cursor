import { Injectable, NotFoundException } from "@nestjs/common";
import { MovieDetailResponseDto } from "../dto/movie-detail-response.dto.js";
import { MovieSummaryResponseDto } from "../dto/movie-summary-response.dto.js";
import { MovieRepository } from "../repository/movie.repository.js";

@Injectable()
export class MovieService {
  constructor(private readonly movieRepository: MovieRepository) {}

  async getMovies(): Promise<MovieSummaryResponseDto[]> {
    const movies = await this.movieRepository.findMany();

    return movies.map((movie) => ({
      id: movie.id,
      title: movie.title,
      posterUrl: movie.posterUrl,
    }));
  }

  async getMovie(id: string): Promise<MovieDetailResponseDto> {
    const movie = await this.movieRepository.findById(id);

    if (!movie) {
      throw new NotFoundException("영화를 찾을 수 없습니다.");
    }

    return {
      id: movie.id,
      title: movie.title,
      description: movie.description,
      posterUrl: movie.posterUrl,
      runtime: movie.runtime,
      releaseDate: toDateOnlyString(movie.releaseDate),
    };
  }
}

function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
