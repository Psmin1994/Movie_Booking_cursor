"use client";

import type { LoginDto } from "@movie-booking/api-client";
import { useLoginMutation } from "@/features/auth/mutations/use-login-mutation";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const loginMutation = useLoginMutation();
  const [form, setForm] = useState<LoginDto>({
    email: "",
    password: "",
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loginMutation.reset();
    loginMutation.mutate(form, {
      onSuccess: () => {
        router.push("/profile");
        router.refresh();
      },
    });
  }

  const errorMessage =
    loginMutation.error instanceof Error ? loginMutation.error.message : null;

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label>
        이메일
        <input
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(event) =>
            setForm((current) => ({ ...current, email: event.target.value }))
          }
        />
      </label>
      <label>
        비밀번호
        <input
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          value={form.password}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              password: event.target.value,
            }))
          }
        />
      </label>
      {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
      <button type="submit" disabled={loginMutation.isPending}>
        {loginMutation.isPending ? "로그인 중..." : "로그인"}
      </button>
      <p className="form-link">
        계정이 없나요? <Link href="/signup">회원가입</Link>
      </p>
    </form>
  );
}
