import { execSync } from "node:child_process";
import type { NextConfig } from "next";

/**
 * Vercel bakes its own commit sha into `VERCEL_GIT_COMMIT_SHA` at build time;
 * locally there's no such thing, so this asks git directly. Baked into the
 * bundle now — a build never picks up the sha of a later commit.
 */
function commitSha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { cwd: __dirname }).toString().trim();
  } catch {
    return null;
  }
}

const nextConfig: NextConfig = {
  env: {
    COMMIT_SHA: commitSha() ?? undefined,
  },
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
