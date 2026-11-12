import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Movie Booking",
  description: "영화 예매 서비스",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <header className="site-header">
          <Link href="/" className="site-logo">
            Movie Booking
          </Link>
          <nav className="site-nav">
            <Link href="/movies">영화</Link>
            <Link href="/booking">예매</Link>
            <Link href="/bookings">내 예매</Link>
            <Link href="/signup">회원가입</Link>
            <Link href="/login">로그인</Link>
            <Link href="/profile">내 정보</Link>
          </nav>
        </header>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
