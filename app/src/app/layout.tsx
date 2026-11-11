import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { Footer, Header } from "@/components/ui";
import { Providers } from "@/components/providers";
import { Ambience } from "@/components/ambience";
import en from "@/locales/en.json";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: en.meta.title,
  description: en.meta.description,
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable}`}>
      <body className={`${inter.className} relative bg-[#05070c] font-sans antialiased`}>
        <Ambience />
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="blob absolute left-1/2 top-0 h-[320px] w-[680px] -translate-x-1/2 bg-gradient-to-tr from-cyan-400/20 via-indigo-500/16 to-emerald-400/10 blur-[110px]" />
          <div className="blob-2 absolute right-[6%] top-16 h-[240px] w-[280px] bg-rose-500/16 blur-[90px]" />
        </div>
        <Providers>
          <Header />
          <main className="page-width relative z-10 mx-auto min-h-[calc(100vh-8rem)] px-4 py-6">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
