import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { Header } from "@/components/ui";
import { Providers } from "@/components/providers";
import { SceneCanvas } from "@/components/scene";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Veritas",
  description: "Veritas Markets · Binary Prediction Protocol on Solana",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={`${inter.className} relative font-sans antialiased`}>
        <SceneCanvas />
        <div className="pointer-events-none absolute left-1/2 top-0 z-0 h-[300px] w-[600px] -translate-x-1/2 bg-gradient-to-tr from-cyan-500/10 via-indigo-500/10 to-transparent blur-[120px]" />
        <Providers>
          <Header />
          <main className="relative z-10 mx-auto min-h-[calc(100vh-4rem)] max-w-6xl px-4 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
