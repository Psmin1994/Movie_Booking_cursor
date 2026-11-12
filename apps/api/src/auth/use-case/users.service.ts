import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@movie-booking/database-prisma";
import { PrismaService } from "../../database/prisma.service.js";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<StoredUser | undefined> {
    const user = await this.prisma.client.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    return user ?? undefined;
  }

  async findById(id: string): Promise<StoredUser | undefined> {
    const user = await this.prisma.client.user.findUnique({
      where: { id },
    });

    return user ?? undefined;
  }

  async create(input: {
    email: string;
    passwordHash: string;
    name: string;
  }): Promise<StoredUser> {
    try {
      return await this.prisma.client.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash: input.passwordHash,
          name: input.name,
        },
      });
    } catch (error) {
      if (isEmailUniqueViolation(error)) {
        throw new ConflictException("이미 사용 중인 이메일입니다.");
      }

      throw error;
    }
  }

  async getByIdOrFail(id: string): Promise<StoredUser> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException("사용자를 찾을 수 없습니다.");
    }

    return user;
  }
}

function isEmailUniqueViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;

  if (target == null) {
    return true;
  }

  if (typeof target === "string") {
    return target.includes("email");
  }

  if (Array.isArray(target)) {
    return target.includes("email");
  }

  return false;
}
