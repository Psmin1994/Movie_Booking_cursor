export const queryKeys = {
  profile: ["profile"] as const,
  movieScreenings: (movieId: string | null, date: string | null) =>
    ["movieScreenings", movieId, date] as const,
  screeningSeats: (screeningId: string) =>
    ["screeningSeats", screeningId] as const,
  myBookings: ["myBookings"] as const,
  bookingDetail: (bookingId: string) => ["bookingDetail", bookingId] as const,
};
