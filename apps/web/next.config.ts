import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@movie-booking/shared",
    "@movie-booking/api-client",
  ],
};

export default nextConfig;
