import { getHealth } from "@/lib/api/server-request";
import Link from "next/link";

export default async function HomePage() {
  let health: { status: string; service: string } | null = null;

  try {
    const response = await getHealth();
    if (response.status === 200) {
      health = response.data;
    }
  } catch {
    health = null;
  }

  return (
    <main>
      <h1>Movie Booking</h1>
      <p>영화 예매 서비스 프론트엔드</p>
      <section className="quick-links">
        <Link href="/signup">회원가입</Link>
        <Link href="/login">로그인</Link>
        <Link href="/profile">내 정보</Link>
      </section>
      <section className="health-check">
        <h2>API Health Check</h2>
        {health ? (
          <dl>
            <div>
              <dt>status</dt>
              <dd>{health.status}</dd>
            </div>
            <div>
              <dt>service</dt>
              <dd>{health.service}</dd>
            </div>
          </dl>
        ) : (
          <p className="form-error">API 서버에 연결할 수 없습니다.</p>
        )}
      </section>
    </main>
  );
}
