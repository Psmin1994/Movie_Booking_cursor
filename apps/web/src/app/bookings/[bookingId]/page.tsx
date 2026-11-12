import { BookingDetail } from "@/features/booking/components/booking-detail";

type BookingDetailPageProps = {
  params: Promise<{ bookingId: string }>;
};

export default async function BookingDetailPage({ params }: BookingDetailPageProps) {
  const { bookingId } = await params;

  return (
    <main>
      <h1>예매 상세</h1>
      <BookingDetail bookingId={bookingId} />
    </main>
  );
}
