const BOOKING_STATUS_LABEL: Record<string, string> = {
  PENDING: "결제 대기",
  CONFIRMED: "예매 완료",
  FAILED: "예매 실패",
  EXPIRED: "만료",
  CANCELLED: "취소됨",
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "결제 대기",
  AUTHORIZING: "결제 확인 중",
  PAID: "결제 완료",
  FAILED: "결제 실패",
  EXPIRED: "결제 만료",
  CANCELED: "결제 취소",
  RECONCILIATION_REQUIRED: "결제 확인 필요",
};

const REFUND_STATUS_LABEL: Record<string, string> = {
  PENDING: "환불 진행 중",
  COMPLETED: "환불 완료",
  FAILED: "환불 실패",
  REVIEW: "환불 확인 필요",
};

export function formatAmount(amount: number) {
  return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
}

export function formatDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatSeats(seats: Array<{ row: string; number: number }>) {
  if (seats.length === 0) {
    return "선택한 좌석이 없습니다.";
  }

  return seats.map((seat) => `${seat.row}${seat.number}`).join(", ");
}

export function bookingStatusLabel(status: string) {
  return BOOKING_STATUS_LABEL[status] ?? status;
}

export function paymentStatusLabel(status: string) {
  return PAYMENT_STATUS_LABEL[status] ?? status;
}

export function refundStatusLabel(status: string) {
  return REFUND_STATUS_LABEL[status] ?? status;
}
