/**
 * Test Intent:
 * 영화 목록은 summary 필드만 조회하고, id 조회는 detail 필드만 반환함을 보장한다. existsById는 id만 확인해 존재 여부를 반환하고, transaction client가 있으면 그 client를 사용한다. 영화가 없으면 findById는 null이다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";
import { MovieRepository } from "./movie.repository.js";

const MOVIE_ID = "550e8400-e29b-41d4-a716-446655440000";
const RELEASE_DATE = new Date("2010-07-16T00:00:00.000Z");

const MOVIE_SUMMARY = {
  id: MOVIE_ID,
  title: "Inception",
  posterUrl: null,
};

const MOVIE_DETAIL = {
  id: MOVIE_ID,
  title: "Inception",
  description: null,
  posterUrl: null,
  runtime: 148,
  releaseDate: RELEASE_DATE,
};

const movieSummarySelect = {
  id: true,
  title: true,
  posterUrl: true,
};

const movieDetailSelect = {
  id: true,
  title: true,
  description: true,
  posterUrl: true,
  runtime: true,
  releaseDate: true,
};

const movieExistsSelect = {
  id: true,
};

describe("MovieRepository", () => {
  it("lists movies with the summary projection", async () => {
    const findMany = jest.fn<(args: unknown) => Promise<typeof MOVIE_SUMMARY[]>>();
    findMany.mockResolvedValue([MOVIE_SUMMARY]);
    const repository = new MovieRepository({
      client: { movie: { findMany } },
    } as unknown as PrismaService);

    const movies = await repository.findMany();

    expect(findMany).toHaveBeenCalledWith({
      select: movieSummarySelect,
    });
    expect(movies).toEqual([MOVIE_SUMMARY]);
  });

  it("reads a movie by id with the detail projection", async () => {
    const findUnique = jest.fn<(args: unknown) => Promise<typeof MOVIE_DETAIL>>();
    findUnique.mockResolvedValue(MOVIE_DETAIL);
    const repository = new MovieRepository({
      client: { movie: { findUnique } },
    } as unknown as PrismaService);

    const movie = await repository.findById(MOVIE_ID);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: MOVIE_ID },
      select: movieDetailSelect,
    });
    expect(movie).toEqual(MOVIE_DETAIL);
  });

  it("reads a movie by id through the provided transaction client", async () => {
    const findUnique = jest.fn<(args: unknown) => Promise<typeof MOVIE_DETAIL>>();
    findUnique.mockResolvedValue(MOVIE_DETAIL);
    const defaultFindUnique = jest.fn<(args: unknown) => Promise<typeof MOVIE_DETAIL>>();
    const tx = {
      movie: { findUnique },
    } as unknown as Prisma.TransactionClient;
    const repository = new MovieRepository({
      client: { movie: { findUnique: defaultFindUnique } },
    } as unknown as PrismaService);

    const movie = await repository.findById(MOVIE_ID, tx);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: MOVIE_ID },
      select: movieDetailSelect,
    });
    expect(defaultFindUnique).not.toHaveBeenCalled();
    expect(movie).toEqual(MOVIE_DETAIL);
  });

  it("returns null when the movie does not exist", async () => {
    const findUnique = jest.fn<(args: unknown) => Promise<null>>();
    findUnique.mockResolvedValue(null);
    const repository = new MovieRepository({
      client: { movie: { findUnique } },
    } as unknown as PrismaService);

    const movie = await repository.findById(MOVIE_ID);

    expect(movie).toBeNull();
  });

  it("checks movie existence by id without loading the movie row", async () => {
    const findUnique = jest.fn<(args: unknown) => Promise<{ id: string } | null>>();
    findUnique.mockResolvedValueOnce({ id: MOVIE_ID });
    findUnique.mockResolvedValueOnce(null);
    const repository = new MovieRepository({
      client: { movie: { findUnique } },
    } as unknown as PrismaService);

    await expect(repository.existsById(MOVIE_ID)).resolves.toBe(true);
    await expect(repository.existsById(MOVIE_ID)).resolves.toBe(false);

    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: MOVIE_ID },
      select: movieExistsSelect,
    });
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: MOVIE_ID },
      select: movieExistsSelect,
    });
  });

  it("checks movie existence through the provided transaction client", async () => {
    const findUnique = jest.fn<(args: unknown) => Promise<{ id: string }>>();
    findUnique.mockResolvedValue({ id: MOVIE_ID });
    const defaultFindUnique = jest.fn<(args: unknown) => Promise<{ id: string }>>();
    const tx = {
      movie: { findUnique },
    } as unknown as Prisma.TransactionClient;
    const repository = new MovieRepository({
      client: { movie: { findUnique: defaultFindUnique } },
    } as unknown as PrismaService);

    await expect(repository.existsById(MOVIE_ID, tx)).resolves.toBe(true);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: MOVIE_ID },
      select: movieExistsSelect,
    });
    expect(defaultFindUnique).not.toHaveBeenCalled();
  });
});
