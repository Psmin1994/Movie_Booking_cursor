import "reflect-metadata";
import { ApiProperty } from "@nestjs/swagger";
import {
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

@ValidatorConstraint({ name: "isExistingCalendarDate", async: false })
class IsExistingCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const [year, month, day] = value.split("-").map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));

    return (
      calendarDate.getUTCFullYear() === year &&
      calendarDate.getUTCMonth() === month - 1 &&
      calendarDate.getUTCDate() === day
    );
  }

  defaultMessage(): string {
    return "date must be an existing calendar date in YYYY-MM-DD format";
  }
}

export class ListScreeningsByMovieAndDateQueryDto {
  @ApiProperty({
    type: String,
    format: "date",
    example: "2026-09-20",
    description: "YYYY-MM-DD calendar date",
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "date must be in YYYY-MM-DD format",
  })
  @Validate(IsExistingCalendarDateConstraint)
  date!: string;
}
