"use client";

import type { MovieSummaryResponseDto } from "@movie-booking/api-client";
import { getBookingDates } from "@/features/booking/booking-dates";
import { useMovieScreeningsQuery } from "@/features/booking/queries/use-movie-screenings-query";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type BookingSelectorProps = {
  movies: MovieSummaryResponseDto[];
};

export function BookingSelector({ movies }: BookingSelectorProps) {
  const router = useRouter();
  const sliderRef = useRef<HTMLDivElement>(null);
  const dates = getBookingDates();
  const [selectedMovieId, setSelectedMovieId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const screeningsQuery = useMovieScreeningsQuery(selectedMovieId, selectedDate);

  function scrollMovies(direction: -1 | 1) {
    sliderRef.current?.scrollBy({
      left: direction * 180,
      behavior: "smooth",
    });
  }

  return (
    <>
      <section className="booking-section">
        <h2>영화</h2>
        {movies.length > 0 ? (
          <div className="booking-slider">
            <button
              type="button"
              className="booking-slider-nav"
              onClick={() => scrollMovies(-1)}
              aria-label="이전 영화"
            >
              이전
            </button>
            <div className="booking-slider-track" ref={sliderRef}>
              {movies.map((movie) => (
                <button
                  key={movie.id}
                  type="button"
                  className="booking-movie"
                  aria-pressed={selectedMovieId === movie.id}
                  onClick={() => setSelectedMovieId(movie.id)}
                >
                  {movie.posterUrl ? (
                    <img
                      className="booking-movie-poster"
                      src={movie.posterUrl}
                      alt=""
                    />
                  ) : (
                    <span className="booking-movie-poster" />
                  )}
                  <span className="booking-movie-title">{movie.title}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="booking-slider-nav"
              onClick={() => scrollMovies(1)}
              aria-label="다음 영화"
            >
              다음
            </button>
          </div>
        ) : (
          <p>등록된 영화가 없습니다.</p>
        )}
      </section>

      <section className="booking-section">
        <h2>날짜</h2>
        <div className="booking-dates" role="group" aria-label="예매 날짜">
          {dates.map((date) => (
            <button
              key={date.value}
              type="button"
              className="booking-date"
              aria-pressed={selectedDate === date.value}
              onClick={() => setSelectedDate(date.value)}
            >
              {date.label}
              <span>{date.value}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="booking-section">
        <h2>상영</h2>
        {selectedMovieId === null || selectedDate === null ? (
          <p>영화와 날짜를 선택하면 상영 시간이 표시됩니다.</p>
        ) : screeningsQuery.isPending ? (
          <p>상영 정보를 불러오는 중...</p>
        ) : screeningsQuery.isError ? (
          <p className="form-error">
            {screeningsQuery.error instanceof Error
              ? screeningsQuery.error.message
              : "상영 정보를 불러오지 못했습니다."}
          </p>
        ) : screeningsQuery.data.screens.length > 0 ? (
          <div className="booking-screens">
            {screeningsQuery.data.screens.map((group) => (
              <article key={group.screen.id} className="booking-screen">
                <h3>
                  {group.screen.floor}층 {group.screen.number}관{" "}
                  {group.screen.screenType}
                </h3>
                <div className="booking-times">
                  {group.screenings.map((screening) => (
                    <button
                      key={screening.id}
                      type="button"
                      className="booking-time"
                      onClick={() =>
                        router.push(`/booking/seats/${screening.id}`)
                      }
                    >
                      {screening.startTime}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p>선택한 날짜에 상영이 없습니다.</p>
        )}
      </section>
    </>
  );
}
