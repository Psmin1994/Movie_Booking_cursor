import Link from "next/link";

type BookingPaymentFailPageProps = {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<{
    code?: string | string[];
    message?: string | string[];
    orderId?: string | string[];
  }>;
};

function readParam(value: string | string[] | undefined) {
  const param = Array.isArray(value) ? value[0] : value;

  if (typeof param !== "string" || param.trim().length === 0) {
    return null;
  }

  return param;
}

export default async function BookingPaymentFailPage({
  params,
  searchParams,
}: BookingPaymentFailPageProps) {
  const { bookingId } = await params;
  const query = await searchParams;
  const code = readParam(query.code);
  const message = readParam(query.message);
  const orderId = readParam(query.orderId);

  return (
    <main>
      <h1>결제 요청 실패</h1>
      <section className="booking-payment">
        <p>결제가 완료되지 않았습니다.</p>
        <p>결제를 다시 시도할 수 있습니다.</p>
        <dl>
          <div>
            <dt>예매 번호</dt>
            <dd>{bookingId}</dd>
          </div>
          <div>
            <dt>오류 코드</dt>
            <dd>{code ?? "-"}</dd>
          </div>
          <div>
            <dt>오류 메시지</dt>
            <dd>{message ?? "-"}</dd>
          </div>
          <div>
            <dt>주문 번호</dt>
            <dd>{orderId ?? "-"}</dd>
          </div>
        </dl>
        <Link href={`/booking/payment/${bookingId}`}>결제 화면으로 돌아가기</Link>
      </section>
    </main>
  );
}
