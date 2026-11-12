import { useMutation } from "@tanstack/react-query";
import type { LoginDto } from "@movie-booking/api-client";
import { login } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";

export function useLoginMutation() {
  return useMutation({
    mutationFn: async (loginDto: LoginDto) => {
      try {
        const response = await login(loginDto);
        if (response.status !== 200) {
          throw new Error("로그인에 실패했습니다.");
        }
        return response;
      } catch (error) {
        rethrowApiError(error, "로그인 요청 중 오류가 발생했습니다.");
      }
    },
  });
}
