import {
  authControllerLogin,
  authControllerLogout,
  authControllerSignup,
  bookingControllerCreateBooking,
  bookingControllerCancelBooking,
  bookingControllerCancelPendingBooking,
  bookingControllerGetBookingDetail,
  bookingControllerGetMyBookings,
  paymentControllerCreate,
  paymentControllerPay,
  movieScreeningsControllerListScreeningsByMovieAndDate,
  screeningControllerGetScreeningSeats,
  type CreateBookingDto,
  type CreatePaymentDto,
  type LoginDto,
  type MovieScreeningsControllerListScreeningsByMovieAndDateParams,
  type PayPaymentDto,
  type SignupDto,
} from "@movie-booking/api-client";

export async function login(loginDto: LoginDto, options?: RequestInit) {
  return authControllerLogin(loginDto, options);
}

export async function signup(signupDto: SignupDto, options?: RequestInit) {
  return authControllerSignup(signupDto, options);
}

export async function logout(options?: RequestInit) {
  return authControllerLogout(options);
}

export async function getMovieScreenings(
  movieId: string,
  params: MovieScreeningsControllerListScreeningsByMovieAndDateParams,
  options?: RequestInit,
) {
  return movieScreeningsControllerListScreeningsByMovieAndDate(
    movieId,
    params,
    options,
  );
}

export async function getScreeningSeats(
  screeningId: string,
  options?: RequestInit,
) {
  return screeningControllerGetScreeningSeats(screeningId, options);
}

export async function createBooking(
  createBookingDto: CreateBookingDto,
  options?: RequestInit,
) {
  return bookingControllerCreateBooking(createBookingDto, options);
}

export async function getMyBookings(options?: RequestInit) {
  return bookingControllerGetMyBookings(options);
}

export async function getBookingDetail(bookingId: string, options?: RequestInit) {
  return bookingControllerGetBookingDetail(bookingId, options);
}

export async function cancelBooking(bookingId: string, options?: RequestInit) {
  return bookingControllerCancelBooking(bookingId, options);
}

export async function cancelPendingBooking(bookingId: string, options?: RequestInit) {
  return bookingControllerCancelPendingBooking(bookingId, options);
}

export async function createPayment(
  createPaymentDto: CreatePaymentDto,
  options?: RequestInit,
) {
  return paymentControllerCreate(createPaymentDto, options);
}

export async function payPayment(
  paymentId: string,
  payPaymentDto: PayPaymentDto,
  options?: RequestInit,
) {
  return paymentControllerPay(paymentId, payPaymentDto, options);
}
