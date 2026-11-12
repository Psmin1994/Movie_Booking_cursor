import { BookingPaymentSuccess } from "@/features/booking/components/booking-payment-success";

type BookingPaymentSuccessPageProps = {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{
    paymentKey?: string | string[];
    orderId?: string | string[];
    amount?: string | string[];
  }>;
};

function readParam(value: string | string[] | undefined) {
  const param = Array.isArray(value) ? value[0] : value;

  if (typeof param !== "string" || param.trim().length === 0) {
    return null;
  }

  return param;
}

function readAmount(value: string | string[] | undefined) {
  const param = readParam(value);

  if (param === null || !/^[0-9]+$/.test(param)) {
    return null;
  }

  const amount = Number(param);

  if (!Number.isSafeInteger(amount)) {
    return null;
  }

  return amount;
}

export default async function BookingPaymentSuccessPage({
  params,
  searchParams,
}: BookingPaymentSuccessPageProps) {
  const { bookingId } = await params;
  const query = await searchParams;
  const paymentKey = readParam(query.paymentKey);
  const orderId = readParam(query.orderId);
  const amount = readAmount(query.amount);

  return (
    <main>
      <h1>결제</h1>
      <BookingPaymentSuccess
        bookingId={bookingId}
        paymentKey={paymentKey}
        orderId={orderId}
        amount={amount}
      />
    </main>
  );
}
