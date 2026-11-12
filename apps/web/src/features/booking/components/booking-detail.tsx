"use client";

import Link from "next/link";
import { useState } from "react";
import type { GetBookingDetailResponseDto } from "@movie-booking/api-client";
import {
  bookingStatusLabel,
  formatAmount,
  formatDateTime,
  formatSeats,
  paymentStatusLabel,
  refundStatusLabel,
} from "@/features/booking/booking-display";
import { ReconciliationRequiredNotice } from "@/features/booking/components/reconciliation-required-notice";
import { useCancelConfirmedBookingMutation } from "@/features/booking/mutations/use-cancel-confirmed-booking-mutation";
import { useBookingDetailQuery } from "@/features/booking/queries/use-booking-detail-query";
import { isCancelledWithReconciliationRequired } from "@/features/booking/reconciliation-required";

type BookingDetailProps = {
  bookingId: string;
};

const BOOKING_CONFIRMED_STATUS = "CONFIRMED";
const BOOKING_PENDING_STATUS = "PENDING";
const PAYMENT_PAID_STATUS = "PAID";
const PAYMENT_AUTHORIZING_STATUS = "AUTHORIZING";

function canCancelConfirmedBooking(booking: GetBookingDetailResponseDto) {
  return booking.status === BOOKING_CONFIRMED_STATUS && booking.payment?.status === PAYMENT_PAID_STATUS;
}

export function BookingDetail({ bookingId }: BookingDetailProps) {
  const bookingDetailQuery = useBookingDetailQuery(bookingId);
  const cancelConfirmedBookingMutation = useCancelConfirmedBookingMutation();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const booking = bookingDetailQuery.data;
  const isWorking = cancelConfirmedBookingMutation.isPending;

  if (bookingDetailQuery.isPending) {
    return <p>예매 정보를 불러오는 중...</p>;
  }

  if (bookingDetailQuery.isError || !booking) {
    const message =
      bookingDetailQuery.error instanceof Error
        ? bookingDetailQuery.error.message
        : "예매 정보를 불러오지 못했습니다.";

    return (
      <div>
        <p className="form-error">{message}</p>
        {message === "인증이 필요합니다." ? (
          <p className="form-link">
            <Link href="/login">로그인</Link>
          </p>
        ) : (
          <p className="form-link">
            <Link href="/bookings">내 예매 목록</Link>
          </p>
        )}
      </div>
    );
  }

  const actionError = cancelConfirmedBookingMutation.isError
    ? cancelConfirmedBookingMutation.error
    : null;

  return (
    <section className="booking-payment">
      <h2>{booking.movie.title}</h2>
      <dl>
        <div>
          <dt>상태</dt>
          <dd>{bookingStatusLabel(booking.status)}</dd>
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
          <dd>{formatSeats(booking.seats)}</dd>
        </div>
        {booking.confirmedAt ? (
          <div>
            <dt>확정</dt>
            <dd>{formatDateTime(booking.confirmedAt)}</dd>
          </div>
        ) : null}
        {booking.cancelledAt ? (
          <div>
            <dt>취소</dt>
            <dd>{formatDateTime(booking.cancelledAt)}</dd>
          </div>
        ) : null}
        {booking.payment ? (
          <>
            <div>
              <dt>결제 금액</dt>
              <dd>{formatAmount(booking.payment.amount)}</dd>
            </div>
            <div>
              <dt>결제 상태</dt>
              <dd>{paymentStatusLabel(booking.payment.status)}</dd>
            </div>
          </>
        ) : null}
      </dl>

      {booking.payment && booking.payment.refunds.length > 0 ? (
        <div>
          <h3>환불</h3>
          {booking.payment.refunds.map((refund) => (
            <dl key={refund.id}>
              <div>
                <dt>상태</dt>
                <dd>{refundStatusLabel(refund.status)}</dd>
              </div>
              <div>
                <dt>금액</dt>
                <dd>{formatAmount(refund.amount)}</dd>
              </div>
              {refund.completedAt ? (
                <div>
                  <dt>완료</dt>
                  <dd>{formatDateTime(refund.completedAt)}</dd>
                </div>
              ) : null}
              {refund.failedAt ? (
                <div>
                  <dt>실패</dt>
                  <dd>{formatDateTime(refund.failedAt)}</dd>
                </div>
              ) : null}
            </dl>
          ))}
        </div>
      ) : null}

      {isCancelledWithReconciliationRequired(booking.status, booking.payment?.status) ? (
        <ReconciliationRequiredNotice />
      ) : null}

      {booking.status === BOOKING_PENDING_STATUS && booking.payment?.status === PAYMENT_AUTHORIZING_STATUS ? (
        <p>결제 결과를 확인하는 중에는 취소할 수 없습니다. 결제가 완료되면 이 페이지에서 취소와 환불을 진행할 수 있습니다.</p>
      ) : null}

      {booking.status === BOOKING_PENDING_STATUS && booking.payment?.status !== PAYMENT_AUTHORIZING_STATUS ? (
        <p>결제 전 취소는 결제 화면에서 할 수 있습니다. 결제가 끝나기 전에는 환불이 만들어지지 않습니다.</p>
      ) : null}

      {actionError ? (
        <p className="form-error">
          {actionError instanceof Error ? actionError.message : "요청에 실패했습니다."}
        </p>
      ) : null}

      {canCancelConfirmedBooking(booking) && confirmingCancel ? (
        <p>예매를 취소하고 결제 금액을 환불합니다.</p>
      ) : null}

      <div className="booking-cancel-actions">
        <Link href="/bookings" className="booking-reserve">
          목록
        </Link>
        {booking.status === BOOKING_PENDING_STATUS ? (
          <Link href={`/booking/payment/${booking.id}`} className="booking-reserve">
            결제 이어하기
          </Link>
        ) : null}
        {canCancelConfirmedBooking(booking) && confirmingCancel ? (
          <>
            <button
              type="button"
              className="booking-reserve"
              disabled={isWorking}
              onClick={() => {
                cancelConfirmedBookingMutation.mutate(bookingId);
              }}
            >
              {cancelConfirmedBookingMutation.isPending ? "취소 중..." : "환불하고 취소"}
            </button>
            <button
              type="button"
              className="booking-reserve"
              disabled={isWorking}
              onClick={() => {
                setConfirmingCancel(false);
              }}
            >
              돌아가기
            </button>
          </>
        ) : null}
        {canCancelConfirmedBooking(booking) && !confirmingCancel ? (
          <button
            type="button"
            className="booking-reserve"
            disabled={isWorking}
            onClick={() => {
              setConfirmingCancel(true);
            }}
          >
            예매 취소 및 환불
          </button>
        ) : null}
      </div>
    </section>
  );
}
