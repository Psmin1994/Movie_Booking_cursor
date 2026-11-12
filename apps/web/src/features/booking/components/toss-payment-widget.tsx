"use client";

import { useEffect, useRef, useState } from "react";
import {
  ANONYMOUS,
  loadTossPayments,
  type TossPaymentsWidgets,
} from "@tosspayments/tosspayments-sdk";
import type { GetBookingDetailResponseDto } from "@movie-booking/api-client";
import { useBookingDetailQuery } from "@/features/booking/queries/use-booking-detail-query";

const ORDER_NAME_MAX_LENGTH = 100;
const BOOKING_PENDING_STATUS = "PENDING";
const PAYMENT_PENDING_STATUS = "PENDING";
const PAYMENT_METHOD_VARIANT_KEY = "DEFAULT";
const AGREEMENT_VARIANT_KEY = "AGREEMENT";

type TossPaymentWidgetProps = {
  bookingId: string;
};

type WindowSession = {
  id: symbol;
};

type PaymentWindow = Awaited<
  ReturnType<TossPaymentsWidgets["renderPaymentWindow"]>
>;

let activeWindowSession: WindowSession | null = null;

function claimWindowSession(): WindowSession | null {
  if (activeWindowSession) {
    return null;
  }

  const session: WindowSession = { id: Symbol("toss-payment-window") };
  activeWindowSession = session;
  return session;
}

function releaseWindowSession(session: WindowSession) {
  if (activeWindowSession === session) {
    activeWindowSession = null;
  }
}

function paymentRedirectUrl(bookingId: string, result: "success" | "fail") {
  return `${window.location.origin}/booking/payment/${bookingId}/${result}`;
}

function requestErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "결제 요청에 실패했습니다.";
}

function paymentHoldOpen(expiresAt: string) {
  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
}

function payableOrder(booking: GetBookingDetailResponseDto) {
  const payment = booking.payment;
  const orderName = booking.movie.title.trim().slice(0, ORDER_NAME_MAX_LENGTH);

  if (
    !paymentHoldOpen(booking.expiresAt) ||
    booking.status !== BOOKING_PENDING_STATUS ||
    !payment ||
    payment.status !== PAYMENT_PENDING_STATUS ||
    payment.orderId.trim().length === 0 ||
    !Number.isSafeInteger(payment.amount) ||
    orderName.length === 0
  ) {
    return null;
  }

  return {
    amount: payment.amount,
    orderId: payment.orderId,
    orderName,
  };
}

async function destroyPaymentWindow(paymentWindow: PaymentWindow | null) {
  if (!paymentWindow) {
    return;
  }

  try {
    await paymentWindow.destroy();
  } catch {
    // The window can already be gone. destroy() does not emit cancel.
  }
}

export function TossPaymentWidget({ bookingId }: TossPaymentWidgetProps) {
  const bookingDetailQuery = useBookingDetailQuery(bookingId);
  const sessionRef = useRef<WindowSession | null>(null);
  const paymentWindowRef = useRef<PaymentWindow | null>(null);
  const openingRef = useRef(false);
  const mountedRef = useRef(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      const paymentWindow = paymentWindowRef.current;
      sessionRef.current = null;
      paymentWindowRef.current = null;
      openingRef.current = false;

      if (session) {
        releaseWindowSession(session);
      }

      void destroyPaymentWindow(paymentWindow);
    };
  }, []);

  function releaseOwnedSession(session: WindowSession) {
    if (sessionRef.current !== session) {
      return;
    }

    sessionRef.current = null;
    openingRef.current = false;
    releaseWindowSession(session);

    if (mountedRef.current) {
      setBusy(false);
    }
  }

  async function handlePay() {
    if (busy || openingRef.current) {
      return;
    }

    openingRef.current = true;
    const session = claimWindowSession();

    if (!session) {
      openingRef.current = false;
      setErrorMessage("결제창이 이미 열려 있습니다.");
      return;
    }

    sessionRef.current = session;
    setBusy(true);
    setErrorMessage(null);

    try {
      const result = await bookingDetailQuery.refetch();

      if (sessionRef.current !== session) {
        return;
      }

      if (result.isError || !result.data) {
        setErrorMessage(
          result.error instanceof Error
            ? result.error.message
            : "예매 정보를 불러오지 못했습니다.",
        );
        releaseOwnedSession(session);
        return;
      }

      if (!paymentHoldOpen(result.data.expiresAt)) {
        setErrorMessage("결제 가능 시간이 지났습니다.");
        releaseOwnedSession(session);
        return;
      }

      const order = payableOrder(result.data);

      if (!order) {
        setErrorMessage("결제를 진행할 수 없는 상태입니다.");
        releaseOwnedSession(session);
        return;
      }

      const clientKey = process.env.NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY?.trim();

      if (!clientKey) {
        setErrorMessage("결제 UI를 불러오지 못했습니다.");
        releaseOwnedSession(session);
        return;
      }

      const tossPayments = await loadTossPayments(clientKey);

      if (sessionRef.current !== session) {
        return;
      }

      const widgets = tossPayments.widgets({ customerKey: ANONYMOUS });
      await widgets.setAmount({
        currency: "KRW",
        value: order.amount,
      });

      if (sessionRef.current !== session) {
        return;
      }

      const paymentWindow = await widgets.renderPaymentWindow({
        variantKey: {
          paymentMethod: PAYMENT_METHOD_VARIANT_KEY,
          agreement: AGREEMENT_VARIANT_KEY,
        },
      });

      if (sessionRef.current !== session) {
        await destroyPaymentWindow(paymentWindow);
        return;
      }

      paymentWindowRef.current = paymentWindow;
      let paymentRequested = false;

      paymentWindow.on("cancel", async () => {
        if (paymentWindowRef.current === paymentWindow) {
          paymentWindowRef.current = null;
        }

        releaseOwnedSession(session);
      });

      paymentWindow.on("paymentRequest", async () => {
        if (paymentRequested || sessionRef.current !== session) {
          return;
        }

        paymentRequested = true;

        try {
          await widgets.requestPayment({
            orderId: order.orderId,
            orderName: order.orderName,
            successUrl: paymentRedirectUrl(bookingId, "success"),
            failUrl: paymentRedirectUrl(bookingId, "fail"),
          });
        } catch (error) {
          paymentRequested = false;

          if (paymentWindowRef.current === paymentWindow) {
            paymentWindowRef.current = null;
            await destroyPaymentWindow(paymentWindow);
          }

          if (sessionRef.current === session && mountedRef.current) {
            setErrorMessage(requestErrorMessage(error));
          }

          releaseOwnedSession(session);
        }
      });
    } catch (error) {
      if (paymentWindowRef.current) {
        const paymentWindow = paymentWindowRef.current;
        paymentWindowRef.current = null;
        await destroyPaymentWindow(paymentWindow);
      }

      if (sessionRef.current === session && mountedRef.current) {
        setErrorMessage(requestErrorMessage(error));
      }

      releaseOwnedSession(session);
    }
  }

  return (
    <div className="toss-payment-widget">
      {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
      <button
        type="button"
        className="booking-reserve"
        disabled={busy}
        onClick={() => {
          void handlePay();
        }}
      >
        {busy ? "결제창을 여는 중..." : "결제하기"}
      </button>
    </div>
  );
}
