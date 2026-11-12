import { defineConfig } from "orval";

export default defineConfig({
  movieBooking: {
    input: "../../apps/api/openapi.json",
    output: {
      target: "./src/generated/api.ts",
      client: "fetch",
      clean: true,
      override: {
        mutator: {
          path: "./src/fetcher/fetcher.ts",
          name: "fetcher",
        },
      },
    },
  },
});
