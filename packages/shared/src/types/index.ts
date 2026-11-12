export interface Movie {
  id: string;
  title: string;
  durationMinutes: number;
  rating: string;
}

export interface Screening {
  id: string;
  movieId: string;
  theaterId: string;
  startsAt: string;
}

export interface Booking {
  id: string;
  screeningId: string;
  seatIds: string[];
  status: "pending" | "confirmed" | "cancelled";
}
