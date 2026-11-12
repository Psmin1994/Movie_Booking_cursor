"use client";

import type { SignupDto } from "@movie-booking/api-client";
import { useSignupMutation } from "@/features/auth/mutations/use-signup-mutation";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignupForm() {
  const router = useRouter();
  const signupMutation = useSignupMutation();
  const [form, setForm] = useState<SignupDto>({
    email: "",
    password: "",
    name: "",
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    signupMutation.reset();
    signupMutation.mutate(form, {
      onSuccess: () => {
        router.push("/login");
        router.refresh();
      },
    });
  }

  const errorMessage =
    signupMutation.error instanceof Error ? signupMutation.error.message : null;

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label>
        이름
        <input
          type="text"
          autoComplete="name"
          required
          value={form.name}
          onChange={(event) =>
            setForm((current) => ({ ...current, name: event.target.value }))
          }
        />
      </label>
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
          autoComplete="new-password"
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
      <button type="submit" disabled={signupMutation.isPending}>
        {signupMutation.isPending ? "가입 중..." : "회원가입"}
      </button>
      <p className="form-link">
        이미 계정이 있나요? <Link href="/login">로그인</Link>
      </p>
    </form>
  );
}
