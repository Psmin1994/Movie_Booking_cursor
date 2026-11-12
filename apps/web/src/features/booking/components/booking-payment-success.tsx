"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { GetBookingDetailResponseDto } from "@movie-booking/api-client";
import { ReconciliationRequiredNotice } from "@/features/booking/components/reconciliation-required-notice";
import { usePayPaymentMutation } from "@/features/booking/mutations/use-pay-payment-mutation";
import { useBookingDetailQuery } from "@/features/booking/queries/use-booking-detail-query";
import { PAYMENT_RECONCILIATION_REQUIRED_STATUS } from "@/features/booking/reconciliation-required";

const PAYMENT_PENDING_STATUS = "PENDING";
const PAYMENT_AUTHORIZING_STATUS = "AUTHORIZING";
const PAYMENT_PAID_STATUS = "PAID";
const PAYMENT_FAILED_STATUS = "FAILED";
const PAYMENT_EXPIRED_STATUS = "EXPIRED";

const TERMINAL_BOOKING_STATUSES = new Set([
  PAYMENT_PAID_STATUS,
  PAYMENT_FAILED_STATUS,
  PAYMENT_EXPIRED_STATUS,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
]);

const BOOKING_DETAIL_STATUSES = new Set([
  PAYMENT_AUTHORIZING_STATUS,
  ...TERMINAL_BOOKING_STATUSES,
]);

function paymentStatusForScreen(
  bookingStatus: string,
  mutationStatus: string | null,
  mutationIsError: boolean,
): string | null {
  if (
    !mutationIsError &&
    (mutationStatus === PAYMENT_PAID_STATUS ||
      mutationStatus === PAYMENT_FAILED_STATUS ||
      mutationStatus === PAYMENT_RECONCILIATION_REQUIRED_STATUS)
  ) {
    if (TERMINAL_BOOKING_STATUSES.has(bookingStatus)) {
      return bookingStatus;
    }

    return mutationStatus;
  }

  if (BOOKING_DETAIL_STATUSES.has(bookingStatus)) {
    return bookingStatus;
  }

  return null;
}

type BookingPaymentSuccessProps = {
  bookingId: string;
  paymentKey: string | null;
  orderId: string | null;
  amount: number | null;
};

function redirectMatchesPayment(
  payment: { orderId: string; amount: number },
  paymentKey: string | null,
  orderId: string | null,
  amount: number | null,
) {
  return (
    paymentKey !== null &&
    orderId === payment.orderId &&
    amount === payment.amount
  );
}

function formatAmount(amount: number) {
  return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
}

function formatDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatSeat(seat: { row: string; number: number }) {
  return `${seat.row}${seat.number}`;
}

function PaymentComplete({ booking, paymentStatus }: { booking: GetBookingDetailResponseDto; paymentStatus: string }) {
  const payment = booking.payment;

  if (!payment) {
    return null;
  }

  return (
    <section className="booking-payment">
      <p>결제가 완료되었습니다.</p>
      <dl>
        <div>
          <dt>영화</dt>
          <dd>{booking.movie.title}</dd>
        </div>
        <div>
          <dt>상영</dt>
          <dd>{formatDateTime(booking.screening.startAt)}</dd>
        </div>
        <div>
          <dt>상영관</dt>
          <dd>{booking.screen.number}관</dd>
        </div>
        <div>
          <dt>좌석</dt>
          <dd>{booking.seats.map(formatSeat).join(", ")}</dd>
        </div>
        <div>
          <dt>결제 금액</dt>
          <dd>{formatAmount(payment.amount)}</dd>
        </div>
        <div>
          <dt>결제 상태</dt>
          <dd>{paymentStatus}</dd>
        </div>
        <div>
          <dt>예매 상태</dt>
          <dd>{booking.status}</dd>
        </div>
      </dl>
    </section>
  );
}

export function BookingPaymentSuccess({
  bookingId,
  paymentKey,
  orderId,
  amount,
}: BookingPaymentSuccessProps) {
  const bookingDetailQuery = useBookingDetailQuery(bookingId);
  const payPaymentMutation = usePayPaymentMutation();
  const { mutate } = payPaymentMutation;
  const { refetch } = bookingDetailQuery;
  const requestedPaymentKey = useRef<string | null>(null);
  const payment = bookingDetailQuery.data?.payment ?? null;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await refetch();

      if (cancelled || result.isError || !result.data?.payment || !paymentKey) {
        return;
      }

      const payment = result.data.payment;

      if (payment.status !== PAYMENT_PENDING_STATUS) {
        return;
      }

      if (!redirectMatchesPayment(payment, paymentKey, orderId, amount)) {
        return;
      }

      if (requestedPaymentKey.current === paymentKey) {
        return;
      }

      requestedPaymentKey.current = paymentKey;
      mutate({
        paymentId: payment.id,
        paymentKey,
        bookingId,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [amount, bookingId, mutate, orderId, paymentKey, refetch]);

  if (bookingDetailQuery.isPending) {
    return <p>결제 정보를 확인하는 중입니다.</p>;
  }

  if (bookingDetailQuery.isError) {
    return (
      <p className="form-error">
        {bookingDetailQuery.error instanceof Error
          ? bookingDetailQuery.error.message
          : "예매 정보를 불러오지 못했습니다."}
      </p>
    );
  }

  if (!payment || !bookingDetailQuery.data) {
    return (
      <section className="booking-payment">
        <p className="form-error">결제 정보를 찾을 수 없습니다.</p>
        <Link href={`/booking`}>예매 화면으로 돌아가기</Link>
      </section>
    );
  }

  const redirectVerified = redirectMatchesPayment(
    payment,
    paymentKey,
    orderId,
    amount,
  );

  // URL의 amount, orderId가 서버 Payment와 다르면 승인 API를 호출하지 않는다.
  // 승인 요청 전에 검증이 끝나면 서버 Payment는 PENDING으로 남을 수 있다.
  // 이 화면에서는 기존 Payment 재시도를 유도하지 않는다.
  if (!redirectVerified) {
    return (
      <section className="booking-payment">
        <p>결제 정보를 확인하지 못했습니다.</p>
        <p>승인 요청을 진행하지 않았습니다.</p>
        <dl>
          <div>
            <dt>서버 결제 상태</dt>
            <dd>{payment.status}</dd>
          </div>
          <div>
            <dt>서버 예매 상태</dt>
            <dd>{bookingDetailQuery.data.status}</dd>
          </div>
        </dl>
      </section>
    );
  }

  const mutationMatchesPayment =
    payPaymentMutation.variables?.paymentId === payment.id;
  const mutationStatus =
    payPaymentMutation.isSuccess && mutationMatchesPayment
      ? payPaymentMutation.data.status
      : null;
  const status = paymentStatusForScreen(
    payment.status,
    mutationStatus,
    payPaymentMutation.isError && mutationMatchesPayment,
  );
  const approving =
    payPaymentMutation.isPending && mutationMatchesPayment;

  if (status === PAYMENT_PAID_STATUS) {
    return (
      <PaymentComplete
        booking={bookingDetailQuery.data}
        paymentStatus={status}
      />
    );
  }

  if (approving && payment.status === PAYMENT_PENDING_STATUS) {
    return (
      <section className="booking-payment">
        <p>결제를 승인하는 중입니다.</p>
      </section>
    );
  }

  if (status === PAYMENT_AUTHORIZING_STATUS) {
    return (
      <section className="booking-payment">
        <p>결제 결과를 확인하는 중입니다.</p>
      </section>
    );
  }

  if (status === PAYMENT_EXPIRED_STATUS) {
    return (
      <section className="booking-payment">
        <p className="form-error">결제 가능 시간이 만료되었습니다.</p>
        <Link href={`/booking/payment/${bookingId}`}>결제 화면으로 돌아가기</Link>
      </section>
    );
  }

  if (status === PAYMENT_FAILED_STATUS) {
    return (
      <section className="booking-payment">
        <p className="form-error">결제 승인에 실패했습니다.</p>
        <Link href={`/booking/payment/${bookingId}`}>결제 화면으로 돌아가기</Link>
      </section>
    );
  }

  if (status === PAYMENT_RECONCILIATION_REQUIRED_STATUS) {
    return (
      <section className="booking-payment">
        <ReconciliationRequiredNotice />
      </section>
    );
  }

  if (payPaymentMutation.isError && mutationMatchesPayment) {
    const message =
      payPaymentMutation.error instanceof Error ? payPaymentMutation.error.message : "결제 승인에 실패했습니다.";

    return (
      <section className="booking-payment">
        <p className="form-error">{message}</p>
        <Link href={`/booking/payment/${bookingId}`}>결제 화면으로 돌아가기</Link>
      </section>
    );
  }

  return (
    <section className="booking-payment">
      <p>결제를 승인하는 중입니다.</p>
    </section>
  );
}
