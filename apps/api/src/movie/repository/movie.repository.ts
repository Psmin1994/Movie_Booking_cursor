import { Injectable } from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";

type MovieTransaction = Prisma.TransactionClient;

const movieSummarySelect = {
  id: true,
  title: true,
  posterUrl: true,
} as const;

const movieDetailSelect = {
  id: true,
  title: true,
  description: true,
  posterUrl: true,
  runtime: true,
  releaseDate: true,
} as const;

const movieExistsSelect = {
  id: true,
} as const;

@Injectable()
export class MovieRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany() {
    return this.prisma.client.movie.findMany({
      select: movieSummarySelect,
    });
  }

  findById(id: string, tx?: MovieTransaction) {
    const client = tx ?? this.prisma.client;

    return client.movie.findUnique({
      where: { id },
      select: movieDetailSelect,
    });
  }

  async existsById(id: string, tx?: MovieTransaction): Promise<boolean> {
    const client = tx ?? this.prisma.client;
    const movie = await client.movie.findUnique({
      where: { id },
      select: movieExistsSelect,
    });

    return movie !== null;
  }
}
