import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Coworkers — build and manage AI teammates",
  description:
    "Create AI coworkers, give them a job, and manage them from one place.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const sha = process.env.COMMIT_SHA;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {sha && (
          <a
            href={`https://github.com/HonzaKirchner/TheExecutableWorld/commit/${sha}`}
            target="_blank"
            rel="noreferrer"
            className="fixed bottom-1 left-1 z-50 font-mono text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
          >
            {sha.slice(0, 7)}
          </a>
        )}
      </body>
    </html>
  );
}
