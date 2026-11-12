"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { useCreateBookingMutation } from "@/features/booking/mutations/use-create-booking-mutation";
import { useScreeningSeatsQuery } from "@/features/booking/queries/use-screening-seats-query";

type BookingSeatsProps = {
  screeningId: string;
};

export function BookingSeats({ screeningId }: BookingSeatsProps) {
  const router = useRouter();
  const seatsQuery = useScreeningSeatsQuery(screeningId);
  const createBookingMutation = useCreateBookingMutation();
  const [selectedScreeningSeatIds, setSelectedScreeningSeatIds] = useState<
    string[]
  >([]);

  if (seatsQuery.isPending || seatsQuery.isFetching) {
    return <p>좌석 정보를 불러오는 중...</p>;
  }

  if (seatsQuery.isError) {
    return (
      <p className="form-error">
        {seatsQuery.error instanceof Error
          ? seatsQuery.error.message
          : "좌석 정보를 불러오지 못했습니다."}
      </p>
    );
  }

  const seats = seatsQuery.data.seats;

  function toggleSeat(screeningSeatId: string) {
    createBookingMutation.reset();
    setSelectedScreeningSeatIds((current) =>
      current.includes(screeningSeatId)
        ? current.filter((id) => id !== screeningSeatId)
        : [...current, screeningSeatId],
    );
  }

  function handleReserve() {
    if (selectedScreeningSeatIds.length === 0 || createBookingMutation.isPending) {
      return;
    }

    createBookingMutation.reset();

    createBookingMutation.mutate(
      {
        screeningId,
        screeningSeatIds: selectedScreeningSeatIds,
      },
      {
        onSuccess: (booking) => {
          router.push(`/booking/payment/${booking.id}`);
        },
      },
    );
  }

  if (seats.length === 0) {
    return <p>조회된 좌석이 없습니다.</p>;
  }

  return (
    <>
      <ul className="booking-seats">
        {seats.map((seat, index) => {
          const previous = seats[index - 1];
          const startsNewRow =
            previous !== undefined && previous.row !== seat.row;
          const isBooked = seat.status === "BOOKED";
          const isSelected = selectedScreeningSeatIds.includes(seat.id);
          const displayStatus = isBooked
            ? "BOOKED"
            : isSelected
              ? "SELECTED"
              : "AVAILABLE";

          return (
            <Fragment key={seat.id}>
              {startsNewRow ? (
                <li className="booking-seat-line-break" aria-hidden="true" />
              ) : null}
              <li>
                <button
                  type="button"
                  disabled={isBooked}
                  aria-pressed={isSelected}
                  onClick={() => {
                    if (isBooked) {
                      return;
                    }

                    toggleSeat(seat.id);
                  }}
                >
                  {seat.row}
                  {seat.number} {displayStatus}
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
      <p className="booking-seat-count">
        선택한 좌석: {selectedScreeningSeatIds.length}석
      </p>
      {createBookingMutation.isError ? (
        <p className="form-error">
          {createBookingMutation.error instanceof Error
            ? createBookingMutation.error.message
            : "예매에 실패했습니다."}
        </p>
      ) : null}
      <button
        type="button"
        className="booking-reserve"
        disabled={
          selectedScreeningSeatIds.length === 0 ||
          createBookingMutation.isPending
        }
        onClick={handleReserve}
      >
        {createBookingMutation.isPending ? "예약 중..." : "예약하기"}
      </button>
    </>
  );
}
