import NextAuth from "next-auth";
import Slack from "next-auth/providers/slack";

declare module "next-auth" {
  interface Session {
    slack: {
      userId?: string;
      teamId?: string;
      teamName?: string;
      teamDomain?: string;
    };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    // Auth.js would otherwise look for AUTH_SLACK_ID / AUTH_SLACK_SECRET.
    // We pass these explicitly so the env vars keep Slack's own naming.
    Slack({
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/",
    error: "/",
  },
  callbacks: {
    // Slack's OIDC profile carries the workspace context in namespaced claims.
    // Copy the bits we care about onto the token so pages can read them.
    jwt({ token, profile }) {
      if (profile) {
        token.slackUserId = profile["https://slack.com/user_id"] as string;
        token.slackTeamId = profile["https://slack.com/team_id"] as string;
        token.slackTeamName = profile["https://slack.com/team_name"] as string;
        token.slackTeamDomain = profile["https://slack.com/team_domain"] as string;
      }
      return token;
    },
    session({ session, token }) {
      session.slack = {
        userId: token.slackUserId as string | undefined,
        teamId: token.slackTeamId as string | undefined,
        teamName: token.slackTeamName as string | undefined,
        teamDomain: token.slackTeamDomain as string | undefined,
      };
      return session;
    },
  },
  events: {
    // Record the workspace and the user the first time we see them, and
    // refresh what we know on every subsequent sign-in.
    //
    // Imported dynamically so the database driver stays out of the bundle for
    // src/proxy.ts, which only needs to know whether a session exists.
    async signIn({ profile }) {
      const workspaceId = profile?.["https://slack.com/team_id"] as
        | string
        | undefined;
      const userId = profile?.["https://slack.com/user_id"] as
        | string
        | undefined;
      if (!workspaceId || !userId) return;

      const { initWorkspace } = await import("@/lib/agents");
      await initWorkspace({
        workspaceId,
        workspaceName: profile?.["https://slack.com/team_name"] as string,
        workspaceDomain: profile?.["https://slack.com/team_domain"] as string,
        userId,
        userName: profile?.name as string | undefined,
        userEmail: profile?.email as string | undefined,
        userImage: profile?.picture as string | undefined,
      });
    },
  },
});
