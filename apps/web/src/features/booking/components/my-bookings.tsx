"use client";

import Link from "next/link";
import { useMyBookingsQuery } from "@/features/booking/queries/use-my-bookings-query";
import {
  bookingStatusLabel,
  formatDateTime,
  formatSeats,
} from "@/features/booking/booking-display";

export function MyBookings() {
  const myBookingsQuery = useMyBookingsQuery();

  if (myBookingsQuery.isPending) {
    return <p>예매 목록을 불러오는 중...</p>;
  }

  if (myBookingsQuery.isError) {
    const message =
      myBookingsQuery.error instanceof Error
        ? myBookingsQuery.error.message
        : "예매 목록을 불러오지 못했습니다.";

    return (
      <div>
        <p className="form-error">{message}</p>
        {message === "인증이 필요합니다." ? (
          <p className="form-link">
            <Link href="/login">로그인</Link>
          </p>
        ) : null}
      </div>
    );
  }

  const bookings = myBookingsQuery.data;

  if (bookings.length === 0) {
    return (
      <div>
        <p>예매 내역이 없습니다.</p>
        <p className="form-link">
          <Link href="/booking">영화 예매하기</Link>
        </p>
      </div>
    );
  }

  return (
    <section className="movie-list">
      {bookings.map((booking) => (
        <article key={booking.id} className="movie-card">
          <h2>
            <Link href={`/bookings/${booking.id}`}>{booking.movie.title}</Link>
          </h2>
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
          </dl>
        </article>
      ))}
    </section>
  );
}
