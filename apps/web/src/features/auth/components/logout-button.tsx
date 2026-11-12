"use client";

import { useLogoutMutation } from "@/features/auth/mutations/use-logout-mutation";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const logoutMutation = useLogoutMutation();

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        router.push("/login");
        router.refresh();
      },
    });
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={logoutMutation.isPending}
    >
      {logoutMutation.isPending ? "로그아웃 중..." : "로그아웃"}
    </button>
  );
}
