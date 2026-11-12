/**
 * Test Intent:
 * 영화 목록은 id, 제목, 포스터를 반환하고, 상세는 설명, 러닝타임, 개봉일을 포함해 반환함을 보장한다. 영화가 없으면 찾을 수 없고, 개봉일은 날짜 문자열이다.
 */

import { jest } from "@jest/globals";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MovieRepository } from "../repository/movie.repository.js";
import { MovieService } from "./movie.service.js";

const MOVIE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MOVIE_ID = "550e8400-e29b-41d4-a716-446655440001";
const RELEASE_DATE = new Date("2010-07-16T00:00:00.000Z");

const MOVIE_SUMMARY = {
  id: MOVIE_ID,
  title: "Inception",
  posterUrl: "https://example.com/posters/inception.jpg",
};

const OTHER_MOVIE_SUMMARY = {
  id: OTHER_MOVIE_ID,
  title: "Interstellar",
  posterUrl: null,
};

const MOVIE_DETAIL = {
  id: MOVIE_ID,
  title: "Inception",
  description: "A thief who infiltrates dreams.",
  posterUrl: "https://example.com/posters/inception.jpg",
  runtime: 148,
  releaseDate: RELEASE_DATE,
};

describe("MovieService", () => {
  let service: MovieService;
  let movieRepository: {
    findMany: jest.MockedFunction<MovieRepository["findMany"]>;
    findById: jest.MockedFunction<MovieRepository["findById"]>;
  };

  beforeEach(async () => {
    movieRepository = {
      findMany: jest.fn<MovieRepository["findMany"]>(),
      findById: jest.fn<MovieRepository["findById"]>(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MovieService,
        {
          provide: MovieRepository,
          useValue: movieRepository,
        },
      ],
    }).compile();

    service = moduleRef.get(MovieService);
  });

  it("maps the movie list in repository order", async () => {
    movieRepository.findMany.mockResolvedValue([MOVIE_SUMMARY, OTHER_MOVIE_SUMMARY]);

    const movies = await service.getMovies();

    expect(movieRepository.findMany).toHaveBeenCalledTimes(1);
    expect(movies).toEqual([
      {
        id: MOVIE_ID,
        title: "Inception",
        posterUrl: "https://example.com/posters/inception.jpg",
      },
      {
        id: OTHER_MOVIE_ID,
        title: "Interstellar",
        posterUrl: null,
      },
    ]);
  });

  it("maps a movie detail and formats the release date", async () => {
    movieRepository.findById.mockResolvedValue(MOVIE_DETAIL);

    const movie = await service.getMovie(MOVIE_ID);

    expect(movieRepository.findById).toHaveBeenCalledWith(MOVIE_ID);
    expect(movie).toEqual({
      id: MOVIE_ID,
      title: "Inception",
      description: "A thief who infiltrates dreams.",
      posterUrl: "https://example.com/posters/inception.jpg",
      runtime: 148,
      releaseDate: "2010-07-16",
    });
  });

  it("throws when the movie does not exist", async () => {
    movieRepository.findById.mockResolvedValue(null);

    await expect(service.getMovie(MOVIE_ID)).rejects.toThrow(NotFoundException);
  });
});
