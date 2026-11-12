/**
 * Test Intent:
 * 요청한 상영의 좌석만 읽고, AVAILABLE 좌석만 점유하며, BOOKED 좌석만 해제함을 보장한다. 지정한 transaction에서 조회하는 상영도 그 상영만 본다.
 */

import { jest } from "@jest/globals";
import { Prisma } from "@movie-booking/database-prisma";
import {
  SCREENING_SEAT_AVAILABLE_STATUS,
  SCREENING_SEAT_BOOKED_STATUS,
} from "../screening.constants.js";
import { ScreeningRepository } from "./screening.repository.js";

const SCREENING_ID = "550e8400-e29b-41d4-a716-446655440002";
const SCREENING_SEAT_IDS = [
  "550e8400-e29b-41d4-a716-446655440010",
  "550e8400-e29b-41d4-a716-446655440011",
];

describe("ScreeningRepository screening seats", () => {
  const repository = new ScreeningRepository({} as never);

  it("reads the requested seats for a screening through the transaction", async () => {
    const findMany = jest.fn<(args: unknown) => Promise<{ id: string }[]>>();
    findMany.mockResolvedValue(SCREENING_SEAT_IDS.map((id) => ({ id })));
    const tx = {
      screeningSeat: { findMany },
    } as unknown as Prisma.TransactionClient;

    await repository.findScreeningSeatsByIds(tx, SCREENING_ID, SCREENING_SEAT_IDS);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        screeningId: SCREENING_ID,
        id: { in: SCREENING_SEAT_IDS },
      },
      select: { id: true },
    });
  });

  it("occupies only available seats for the screening with one conditional update", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: SCREENING_SEAT_IDS.length });
    const tx = {
      screeningSeat: { updateMany },
    } as unknown as Prisma.TransactionClient;

    await repository.occupyAvailableSeats(tx, SCREENING_ID, SCREENING_SEAT_IDS);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: SCREENING_SEAT_IDS },
        screeningId: SCREENING_ID,
        status: SCREENING_SEAT_AVAILABLE_STATUS,
      },
      data: {
        status: SCREENING_SEAT_BOOKED_STATUS,
      },
    });
  });

  it("releases only booked seats with one conditional update", async () => {
    const updateMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
    updateMany.mockResolvedValue({ count: SCREENING_SEAT_IDS.length });
    const tx = {
      screeningSeat: { updateMany },
    } as unknown as Prisma.TransactionClient;

    await repository.releaseBookedSeats(tx, SCREENING_SEAT_IDS);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: SCREENING_SEAT_IDS },
        status: SCREENING_SEAT_BOOKED_STATUS,
      },
      data: {
        status: SCREENING_SEAT_AVAILABLE_STATUS,
      },
    });
  });

  it("reads a screening through the transaction client when one is provided", async () => {
    const findUnique = jest.fn<(args: unknown) => Promise<{ id: string; startAt: Date } | null>>();
    findUnique.mockResolvedValue(null);
    const tx = {
      screening: { findUnique },
    } as unknown as Prisma.TransactionClient;

    await repository.findScreeningById(SCREENING_ID, tx);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: SCREENING_ID },
      select: { id: true, startAt: true },
    });
  });
});
