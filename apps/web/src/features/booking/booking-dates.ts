const BOOKING_DATE_COUNT = 4;
const SERVICE_TIMEZONE = "Asia/Seoul";
const EXTRA_BOOKING_DATES = ["2026-12-25"];

export type BookingDateOption = {
  value: string;
  label: string;
};

export function getBookingDates(now = new Date()): BookingDateOption[] {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: SERVICE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = today.split("-").map(Number);

  const dates = Array.from({ length: BOOKING_DATE_COUNT }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    const value = date.toISOString().slice(0, 10);

    return {
      value,
      label: offset === 0 ? "오늘" : `+${offset}일`,
    };
  });

  for (const value of EXTRA_BOOKING_DATES) {
    if (dates.some((date) => date.value === value)) {
      continue;
    }

    const [, month, day] = value.split("-");
    dates.push({
      value,
      label: `${Number(month)}/${Number(day)}`,
    });
  }

  return dates;
}
