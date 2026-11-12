import { PrismaClient } from "@movie-booking/database-prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";

const BCRYPT_SALT_ROUNDS = 10;

const TEST_USER = {
  email: "test@example.com",
  password: "password123",
  name: "Test User",
};

async function seedUsers(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed users.");
  }

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const email = TEST_USER.email.toLowerCase();
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      console.log(
        `Skipped existing test user: ${existingUser.email} (${existingUser.id})`,
      );
      return;
    }

    const passwordHash = await bcrypt.hash(
      TEST_USER.password,
      BCRYPT_SALT_ROUNDS,
    );

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: TEST_USER.name,
      },
    });

    console.log(`Created test user: ${user.email} (${user.id})`);
    console.log(`Login password: ${TEST_USER.password}`);
  } finally {
    await prisma.$disconnect();
  }
}

seedUsers().catch((error: unknown) => {
  console.error("Failed to seed users:", error);
  process.exit(1);
});
