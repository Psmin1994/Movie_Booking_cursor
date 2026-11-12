import { PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";

const MOVIES = [
  {
    title: "Inception",
    description:
      "A thief who infiltrates dreams is offered a chance to have his criminal record erased if he can implant an idea in a target's mind.",
    posterUrl: "https://example.com/posters/inception.jpg",
    runtime: 148,
    releaseDate: dateOnly("2010-07-16"),
  },
  {
    title: "Interstellar",
    description:
      "A team of explorers travels through a wormhole in space in an attempt to ensure humanity's survival.",
    posterUrl: "https://example.com/posters/interstellar.jpg",
    runtime: 169,
    releaseDate: dateOnly("2014-11-07"),
  },
  {
    title: "The Dark Knight",
    description:
      "Batman faces the Joker, a criminal mastermind who plunges Gotham into chaos and forces him to question his own limits.",
    posterUrl: "https://example.com/posters/the-dark-knight.jpg",
    runtime: 152,
    releaseDate: dateOnly("2008-07-18"),
  },
  {
    title: "Parasite",
    description:
      "A poor family schemes to become employed by a wealthy household, setting off a collision between two very different worlds.",
    posterUrl: "https://example.com/posters/parasite.jpg",
    runtime: 132,
    releaseDate: dateOnly("2019-05-30"),
  },
  {
    title: "Dune",
    description:
      "Paul Atreides travels to the desert planet Arrakis, where he is drawn into a struggle over the universe's most valuable resource.",
    posterUrl: "https://example.com/posters/dune.jpg",
    runtime: 155,
    releaseDate: dateOnly("2021-10-22"),
  },
];

function dateOnly(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

async function seedMovies(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed movies.");
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    let createdCount = 0;
    let skippedCount = 0;

    for (const movie of MOVIES) {
      const existingMovie = await prisma.movie.findFirst({
        where: {
          title: movie.title,
          releaseDate: movie.releaseDate,
        },
      });

      if (existingMovie) {
        skippedCount += 1;
        console.log(
          `Skipped existing movie: ${existingMovie.title} (${existingMovie.id})`,
        );
        continue;
      }

      const created = await prisma.movie.create({
        data: movie,
      });

      createdCount += 1;
      console.log(`Created movie: ${created.title} (${created.id})`);
    }

    console.log(
      `Movie seed complete. created=${createdCount}, skipped=${skippedCount}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

seedMovies().catch((error: unknown) => {
  console.error("Failed to seed movies:", error);
  process.exit(1);
});
