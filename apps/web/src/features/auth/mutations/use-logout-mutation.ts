import { useMutation } from "@tanstack/react-query";
import { logout } from "@/lib/api/client-request";
import { rethrowApiError } from "@/lib/api/rethrow-api-error";

export function useLogoutMutation() {
  return useMutation({
    mutationFn: async () => {
      try {
        const response = await logout();
        if (response.status !== 200) {
          throw new Error();
        }
        return response;
      } catch (error) {
        rethrowApiError(error, "");
      }
    },
  });
}
