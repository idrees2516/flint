import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Flint — Cloud Sandboxes & Agent Orchestration",
  description:
    "Persistent Ubuntu sandboxes with SSH, Docker, snapshots and O(1) fork — plus a built-in agent runtime with parallel tool execution. $0.008/hr per 2vCPU·4GB, billed per second, free when stopped.",
  keywords: ["Flint", "sandbox", "AI agents", "cloud VM", "agent runtime", "boat.dev alternative", "developer tools"],
  authors: [{ name: "Flint" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Flint — Every feature. Half the cost.",
    description: "Cloud sandboxes for AI agents: per-second billing, O(1) fork, auto-hibernate, parallel agent tools.",
    siteName: "Flint",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-zinc-950 text-zinc-100`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
