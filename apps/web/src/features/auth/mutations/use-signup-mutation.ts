import { useMutation } from "@tanstack/react-query";
import type { SignupDto } from "@movie-booking/api-client";
import { signup } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";

export function useSignupMutation() {
  return useMutation({
    mutationFn: async (signupDto: SignupDto) => {
      try {
        const response = await signup(signupDto);
        if (response.status !== 201) {
          throw new Error("회원가입에 실패했습니다.");
        }
        return response;
      } catch (error) {
        rethrowApiError(error, "회원가입 요청 중 오류가 발생했습니다.");
      }
    },
  });
}
