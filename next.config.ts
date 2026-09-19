import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  images: {
    remotePatterns: [
      // Slack avatars
      { protocol: "https", hostname: "*.slack-edge.com" },
      { protocol: "https", hostname: "secure.gravatar.com" },
    ],
  },
  allowedDevOrigins: ["test.mvolfik.com"],
};

export default nextConfig;
