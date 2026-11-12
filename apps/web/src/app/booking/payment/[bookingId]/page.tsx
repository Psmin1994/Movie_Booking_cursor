import { BookingPayment } from "@/features/booking/components/booking-payment";

type BookingPaymentPageProps = {
  params: Promise<{ bookingId: string }>;
};

export default async function BookingPaymentPage({
  params,
}: BookingPaymentPageProps) {
  const { bookingId } = await params;

  return (
    <main>
      <h1>결제</h1>
      <BookingPayment bookingId={bookingId} />
    </main>
  );
}
