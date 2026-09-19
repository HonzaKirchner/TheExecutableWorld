import NextAuth from "next-auth";
import Slack from "next-auth/providers/slack";

declare module "next-auth" {
  interface Session {
    slack: {
      userId?: string;
      teamId?: string;
      teamName?: string;
    };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Slack],
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
      }
      return token;
    },
    session({ session, token }) {
      session.slack = {
        userId: token.slackUserId as string | undefined,
        teamId: token.slackTeamId as string | undefined,
        teamName: token.slackTeamName as string | undefined,
      };
      return session;
    },
  },
});
