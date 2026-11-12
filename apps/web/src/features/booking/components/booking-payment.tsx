"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GetBookingDetailResponseDto } from "@movie-booking/api-client";
import { useCreatePaymentMutation } from "@/features/booking/mutations/use-create-payment-mutation";
import { useCancelPendingBookingMutation } from "@/features/booking/mutations/use-cancel-pending-booking-mutation";
import { useBookingDetailQuery } from "@/features/booking/queries/use-booking-detail-query";
import { ReconciliationRequiredNotice } from "@/features/booking/components/reconciliation-required-notice";
import { TossPaymentWidget } from "@/features/booking/components/toss-payment-widget";
import {
  BOOKING_CANCELLED_STATUS,
  isCancelledWithReconciliationRequired,
  PAYMENT_RECONCILIATION_REQUIRED_STATUS,
} from "@/features/booking/reconciliation-required";

type BookingPaymentProps = {
  bookingId: string;
};

const PAYMENT_PENDING_STATUS = "PENDING";
const PAYMENT_AUTHORIZING_STATUS = "AUTHORIZING";
const PAYMENT_PAID_STATUS = "PAID";
const PAYMENT_FAILED_STATUS = "FAILED";
const PAYMENT_EXPIRED_STATUS = "EXPIRED";
const BOOKING_PENDING_STATUS = "PENDING";

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

function BookingAttemptSummary({ booking }: { booking: GetBookingDetailResponseDto }) {
  const seats = booking.seats.map(formatSeat).join(", ");

  return (
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
        <dd>
          {booking.screen.floor}층 {booking.screen.number}관 {booking.screen.screenType}
        </dd>
      </div>
      <div>
        <dt>좌석</dt>
        <dd>{seats || "선택한 좌석이 없습니다."}</dd>
      </div>
    </dl>
  );
}

function formatRemaining(remainingMs: number) {
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isPaymentHoldOpen(expiresAt: string, nowMs: number) {
  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs && expiresAtMs > Date.now();
}

function canCancelPendingBooking(booking: GetBookingDetailResponseDto, nowMs: number) {
  const payment = booking.payment;
  return (
    booking.status === BOOKING_PENDING_STATUS &&
    isPaymentHoldOpen(booking.expiresAt, nowMs) &&
    (payment === null || payment.status === PAYMENT_PENDING_STATUS)
  );
}

function PaymentRemainingTime({
  expiresAt,
  nowMs,
  onElapsed,
}: {
  expiresAt: string;
  nowMs: number;
  onElapsed: () => void;
}) {
  const expiresAtMs = new Date(expiresAt).getTime();
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;

  const remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : Number.NaN;
  const elapsed = Number.isFinite(remainingMs) && remainingMs <= 0;

  useEffect(() => {
    if (!elapsed) {
      return;
    }
    onElapsedRef.current();
    const timer = window.setInterval(() => {
      onElapsedRef.current();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [elapsed]);

  if (!Number.isFinite(remainingMs) || elapsed) {
    return null;
  }

  return <p className="booking-payment-remaining">남은 시간 {formatRemaining(remainingMs)}</p>;
}

export function BookingPayment({ bookingId }: BookingPaymentProps) {
  const bookingDetailQuery = useBookingDetailQuery(bookingId);
  const createPaymentMutation = useCreatePaymentMutation();
  const cancelPendingBookingMutation = useCancelPendingBookingMutation();
  const booking = bookingDetailQuery.data;
  const payment = booking?.payment;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (booking?.status !== BOOKING_PENDING_STATUS) {
      return;
    }

    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [booking?.status]);

  if (bookingDetailQuery.isPending) {
    return <p>결제 정보를 준비하는 중...</p>;
  }

  if (bookingDetailQuery.isError || !booking) {
    return (
      <p className="form-error">
        {bookingDetailQuery.error instanceof Error
          ? bookingDetailQuery.error.message
          : "예매 정보를 불러오지 못했습니다."}
      </p>
    );
  }

  if (isCancelledWithReconciliationRequired(booking.status, payment?.status)) {
    return (
      <section className="booking-payment">
        <ReconciliationRequiredNotice />
        <BookingAttemptSummary booking={booking} />
        <div className="booking-cancel-actions">
          <Link href="/" className="booking-reserve">
            홈으로
          </Link>
          <Link href="/booking" className="booking-reserve">
            다시 예매
          </Link>
        </div>
      </section>
    );
  }

  if (booking.status === BOOKING_CANCELLED_STATUS) {
    return (
      <section className="booking-payment">
        <p>예매가 취소되었습니다.</p>
        <BookingAttemptSummary booking={booking} />
        <div className="booking-cancel-actions">
          <Link href="/" className="booking-reserve">
            홈으로
          </Link>
          <Link href="/booking" className="booking-reserve">
            다시 예매
          </Link>
        </div>
      </section>
    );
  }

  const cancelPendingBookingError = cancelPendingBookingMutation.isError ? (
    <p className="form-error">
      {cancelPendingBookingMutation.error instanceof Error
        ? cancelPendingBookingMutation.error.message
        : "예매 취소에 실패했습니다."}
    </p>
  ) : null;
  const cancelPendingBookingButton = canCancelPendingBooking(booking, nowMs) ? (
    <>
      {cancelPendingBookingError}
      <button
        type="button"
        className="booking-reserve"
        disabled={cancelPendingBookingMutation.isPending || createPaymentMutation.isPending}
        onClick={() => {
          cancelPendingBookingMutation.mutate(bookingId);
        }}>
        {cancelPendingBookingMutation.isPending ? "취소 중..." : "예매 취소"}
      </button>
    </>
  ) : null;

  if (!payment) {
    return (
      <section className="booking-payment">
        <BookingAttemptSummary booking={booking} />
        {createPaymentMutation.isError ? (
          <p className="form-error">
            {createPaymentMutation.error instanceof Error
              ? createPaymentMutation.error.message
              : "결제 생성에 실패했습니다."}
          </p>
        ) : null}
        <button
          type="button"
          className="booking-reserve"
          disabled={createPaymentMutation.isPending || cancelPendingBookingMutation.isPending}
          onClick={() => {
            createPaymentMutation.mutate({ bookingId });
          }}>
          {createPaymentMutation.isPending ? "준비 중..." : "예매하기"}
        </button>
        {cancelPendingBookingButton}
      </section>
    );
  }

  return (
    <section className="booking-payment">
      {payment.status === PAYMENT_PENDING_STATUS ? (
        isPaymentHoldOpen(booking.expiresAt, nowMs) ? (
          <p>결제 준비가 완료되었습니다.</p>
        ) : (
          <>
            <p>결제 가능 시간이 만료되었습니다.</p>
            <p>예매가 취소됩니다.</p>
          </>
        )
      ) : payment.status === PAYMENT_AUTHORIZING_STATUS ? (
        <p>결제 결과를 확인하는 중입니다.</p>
      ) : payment.status === PAYMENT_RECONCILIATION_REQUIRED_STATUS ? (
        <ReconciliationRequiredNotice />
      ) : payment.status === PAYMENT_PAID_STATUS ? (
        <p>이미 결제가 완료된 예매입니다.</p>
      ) : payment.status === PAYMENT_FAILED_STATUS ? (
        <p>결제가 실패했습니다.</p>
      ) : payment.status === PAYMENT_EXPIRED_STATUS ? (
        <>
          <p>결제 가능 시간이 만료되었습니다.</p>
          <p>예매가 취소됩니다.</p>
        </>
      ) : (
        <p>결제 상태: {payment.status}</p>
      )}

      <BookingAttemptSummary booking={booking} />
      <dl>
        <div>
          <dt>예매 번호</dt>
          <dd>{bookingId}</dd>
        </div>
        <div>
          <dt>결제 금액</dt>
          <dd>{formatAmount(payment.amount)}</dd>
        </div>
        <div>
          <dt>결제 상태</dt>
          <dd>{payment.status}</dd>
        </div>
      </dl>

      {payment.status === PAYMENT_PENDING_STATUS ? (
        <>
          <PaymentRemainingTime
            expiresAt={booking.expiresAt}
            nowMs={nowMs}
            onElapsed={() => {
              void bookingDetailQuery.refetch();
            }}
          />
          {isPaymentHoldOpen(booking.expiresAt, nowMs) ? <TossPaymentWidget bookingId={bookingId} /> : null}
          {cancelPendingBookingButton}
        </>
      ) : null}
    </section>
  );
}
