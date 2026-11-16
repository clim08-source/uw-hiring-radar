import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma and the LLM SDKs are loaded from node_modules at runtime, not bundled.
  serverExternalPackages: ["@prisma/client", "prisma"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
