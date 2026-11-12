import { PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";

const SERVICE_TIMEZONE = "Asia/Seoul";
const BOOKING_DATE_COUNT = 4;
const SCREENING_START_HOUR = 14;
const SCREENING_SEAT_INITIAL_STATUS = "AVAILABLE";

const MOVIE = {
  title: "Inception",
  releaseDate: dateOnly("2010-07-16"),
};

const DEV_SCREEN = {
  number: 1,
  floor: 1,
  screenType: "2D",
};

const SEAT_ROWS = ["A", "B", "C", "D"] as const;
const SEAT_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8];

const DEV_SEATS = SEAT_ROWS.flatMap((row) =>
  SEAT_NUMBERS.map((number) => ({
    row,
    number,
    seatType: "STANDARD",
  })),
);

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

async function seedScreenings(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed screenings.");
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const movie = await prisma.movie.findFirst({
      where: {
        title: MOVIE.title,
        releaseDate: MOVIE.releaseDate,
      },
    });

    if (!movie) {
      throw new Error(
        `Movie "${MOVIE.title}" was not found. Run db:seed:movies first.`,
      );
    }

    const now = new Date();
    const today = seoulCalendarDate(now);
    const windowEnd = seoulDateTime(addCalendarDays(today, BOOKING_DATE_COUNT));
    const targetStartAt = seoulDateTime(
      addCalendarDays(today, 1),
      SCREENING_START_HOUR,
    );

    const screen = await ensureScreen(prisma);
    const seats = await ensureSeats(prisma, screen.id);

    const existingScreening = await prisma.screening.findFirst({
      where: {
        movieId: movie.id,
        screenId: screen.id,
        startAt: {
          gt: now,
          lt: windowEnd,
        },
      },
      orderBy: { startAt: "asc" },
    });

    if (existingScreening) {
      const screeningSeatCount = await ensureScreeningSeats(
        prisma,
        existingScreening.id,
        seats.map((seat) => seat.id),
      );
      const when = formatSeoulDateTime(existingScreening.startAt);

      console.log(
        `Skipped existing screening: ${movie.title} ${when.date} ${when.time} (${existingScreening.id})`,
      );
      console.log(
        `Screening seed complete. movie=${movie.title} date=${when.date} startTime=${when.time} screen=${screen.floor}층 ${screen.number}관 ${screen.screenType} screeningSeats=${screeningSeatCount} created=0 skipped=1`,
      );
      return;
    }

    const conflictingScreening = await prisma.screening.findUnique({
      where: {
        screenId_startAt: {
          screenId: screen.id,
          startAt: targetStartAt,
        },
      },
    });

    if (conflictingScreening) {
      throw new Error(
        `Screen ${screen.number} already has a screening at ${targetStartAt.toISOString()} for another movie (${conflictingScreening.movieId}).`,
      );
    }

    const screening = await prisma.$transaction(async (tx) => {
      const created = await tx.screening.create({
        data: {
          movieId: movie.id,
          screenId: screen.id,
          startAt: targetStartAt,
        },
      });

      await tx.screeningSeat.createMany({
        data: seats.map((seat) => ({
          screeningId: created.id,
          seatId: seat.id,
          status: SCREENING_SEAT_INITIAL_STATUS,
        })),
      });

      return created;
    });

    const when = formatSeoulDateTime(screening.startAt);
    console.log(
      `Created screening: ${movie.title} ${when.date} ${when.time} (${screening.id})`,
    );
    console.log(
      `Screening seed complete. movie=${movie.title} date=${when.date} startTime=${when.time} screen=${screen.floor}층 ${screen.number}관 ${screen.screenType} screeningSeats=${seats.length} created=1 skipped=0`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function ensureScreen(prisma: PrismaClient) {
  const existingScreen = await prisma.screen.findUnique({
    where: { number: DEV_SCREEN.number },
  });

  if (existingScreen) {
    console.log(
      `Skipped existing screen: ${existingScreen.number} (${existingScreen.id})`,
    );
    return existingScreen;
  }

  const created = await prisma.screen.create({
    data: DEV_SCREEN,
  });
  console.log(`Created screen: ${created.number} (${created.id})`);
  return created;
}

async function ensureSeats(prisma: PrismaClient, screenId: string) {
  const seats = [];
  let createdCount = 0;
  let skippedCount = 0;

  for (const seat of DEV_SEATS) {
    const existingSeat = await prisma.seat.findUnique({
      where: {
        screenId_row_number: {
          screenId,
          row: seat.row,
          number: seat.number,
        },
      },
    });

    if (existingSeat) {
      seats.push(existingSeat);
      skippedCount += 1;
      continue;
    }

    const created = await prisma.seat.create({
      data: {
        screenId,
        row: seat.row,
        number: seat.number,
        seatType: seat.seatType,
      },
    });
    seats.push(created);
    createdCount += 1;
    console.log(`Created seat: ${created.row}${created.number} (${created.id})`);
  }

  if (skippedCount > 0) {
    console.log(
      `Skipped existing seats: screenId=${screenId} count=${skippedCount}`,
    );
  }

  console.log(`Seat ensure complete. created=${createdCount} total=${seats.length}`);
  return seats;
}

async function ensureScreeningSeats(
  prisma: PrismaClient,
  screeningId: string,
  seatIds: string[],
): Promise<number> {
  const existingSeats = await prisma.screeningSeat.findMany({
    where: { screeningId },
    select: { seatId: true },
  });
  const existingSeatIds = new Set(existingSeats.map((seat) => seat.seatId));
  const missingSeatIds = seatIds.filter((seatId) => !existingSeatIds.has(seatId));

  if (missingSeatIds.length > 0) {
    await prisma.screeningSeat.createMany({
      data: missingSeatIds.map((seatId) => ({
        screeningId,
        seatId,
        status: SCREENING_SEAT_INITIAL_STATUS,
      })),
    });
    console.log(`Created screening seats: ${missingSeatIds.length}`);
  }

  return existingSeats.length + missingSeatIds.length;
}

function dateOnly(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

function seoulCalendarDate(instant: Date): CalendarDate {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: SERVICE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  const [year, month, day] = formatted.split("-").map(Number);

  return { year, month, day };
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function seoulDateTime(date: CalendarDate, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day, hour - 9, minute));
}

function formatSeoulDateTime(instant: Date): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: SERVICE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: SERVICE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);

  return { date, time };
}

seedScreenings().catch((error: unknown) => {
  console.error("Failed to seed screenings:", error);
  process.exit(1);
});
