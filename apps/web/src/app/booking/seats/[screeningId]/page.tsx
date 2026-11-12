import { BookingSeats } from "@/features/booking/components/booking-seats";

type BookingSeatsPageProps = {
  params: Promise<{ screeningId: string }>;
};

export default async function BookingSeatsPage({
  params,
}: BookingSeatsPageProps) {
  const { screeningId } = await params;

  return (
    <main>
      <h1>좌석 선택</h1>
      <BookingSeats screeningId={screeningId} />
    </main>
  );
}
