export const BOOKING_CANCELLED_STATUS = "CANCELLED";
export const PAYMENT_RECONCILIATION_REQUIRED_STATUS = "RECONCILIATION_REQUIRED";

export function isCancelledWithReconciliationRequired(
  bookingStatus: string,
  paymentStatus: string | null | undefined,
): boolean {
  return (
    bookingStatus === BOOKING_CANCELLED_STATUS &&
    paymentStatus === PAYMENT_RECONCILIATION_REQUIRED_STATUS
  );
}
