import { Injectable } from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";
import {
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../screening.constants.js";

type ScreeningTransaction = Prisma.TransactionClient;

@Injectable()
export class ScreeningRepository {
  constructor(private readonly prisma: PrismaService) {}

  findScreeningsByMovieIdAndDateRange(movieId: string, from: Date, to: Date) {
    return this.prisma.client.screening.findMany({
      where: {
        movieId,
        startAt: {
          gte: from,
          lt: to,
        },
      },
      orderBy: [{ screen: { number: "asc" } }, { startAt: "asc" }],
      select: {
        id: true,
        startAt: true,
        screen: {
          select: {
            id: true,
            number: true,
            floor: true,
            screenType: true,
          },
        },
      },
    });
  }

  findScreeningDetailById(id: string) {
    return this.prisma.client.screening.findUnique({
      where: { id },
      select: {
        id: true,
        startAt: true,
        movie: {
          select: {
            id: true,
            title: true,
            posterUrl: true,
            runtime: true,
          },
        },
        screen: {
          select: {
            id: true,
            number: true,
            floor: true,
            screenType: true,
          },
        },
        screeningSeats: {
          orderBy: [{ seat: { row: "asc" } }, { seat: { number: "asc" } }],
          select: {
            id: true,
            status: true,
            seat: {
              select: {
                id: true,
                row: true,
                number: true,
                seatType: true,
              },
            },
          },
        },
      },
    });
  }

  findScreeningById(id: string, tx?: ScreeningTransaction) {
    const client = tx ?? this.prisma.client;

    return client.screening.findUnique({
      where: { id },
      select: {
        id: true,
        startAt: true,
      },
    });
  }

  findScreeningSeatsByScreeningId(screeningId: string) {
    return this.prisma.client.screeningSeat.findMany({
      where: { screeningId },
      orderBy: [{ seat: { row: "asc" } }, { seat: { number: "asc" } }],
      select: {
        id: true,
        status: true,
        seat: {
          select: {
            row: true,
            number: true,
          },
        },
      },
    });
  }

  findScreenById(tx: ScreeningTransaction, screenId: string) {
    return tx.screen.findUnique({
      where: { id: screenId },
      select: { id: true },
    });
  }

  findSeatsByScreenId(tx: ScreeningTransaction, screenId: string) {
    return tx.seat.findMany({
      where: { screenId },
      select: { id: true },
    });
  }

  createScreening(
    tx: ScreeningTransaction,
    data: {
      movieId: string;
      screenId: string;
      startAt: Date;
    },
  ) {
    return tx.screening.create({
      data,
      select: {
        id: true,
        movieId: true,
        screenId: true,
        startAt: true,
      },
    });
  }

  createScreeningSeats(
    tx: ScreeningTransaction,
    data: {
      screeningId: string;
      seatIds: string[];
      status: string;
    },
  ) {
    return tx.screeningSeat.createMany({
      data: data.seatIds.map((seatId) => ({
        screeningId: data.screeningId,
        seatId,
        status: data.status,
      })),
    });
  }

  findScreeningSeatsByIds(tx: ScreeningTransaction, screeningId: string, screeningSeatIds: string[]) {
    return tx.screeningSeat.findMany({
      where: {
        screeningId,
        id: { in: screeningSeatIds },
      },
      select: { id: true },
    });
  }

  occupyAvailableSeats(tx: ScreeningTransaction, screeningId: string, screeningSeatIds: string[]) {
    return tx.screeningSeat.updateMany({
      where: {
        id: { in: screeningSeatIds },
        screeningId,
        status: SCREENING_SEAT_AVAILABLE_STATUS,
      },
      data: {
        status: SCREENING_SEAT_BOOKED_STATUS,
      },
    });
  }

  releaseBookedSeats(tx: ScreeningTransaction, screeningSeatIds: string[]) {
    return tx.screeningSeat.updateMany({
      where: {
        id: { in: screeningSeatIds },
        status: SCREENING_SEAT_BOOKED_STATUS,
      },
      data: {
        status: SCREENING_SEAT_AVAILABLE_STATUS,
      },
    });
  }
}
