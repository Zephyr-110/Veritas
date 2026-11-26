import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer, Header } from "@/components/ui";
import { Providers } from "@/components/providers";
import { Ambience } from "@/components/ambience";
import en from "@/locales/en.json";
import "./globals.css";
import "./fonts.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://veritas.zephyr110.com"),
  title: { default: en.meta.title, template: "%s | Veritas" },
  openGraph: {
    type: "website", siteName: "Veritas", title: en.meta.title, description: en.meta.description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Veritas prediction market on Solana Devnet" }],
  },
  twitter: {
    card: "summary_large_image", title: en.meta.title, description: en.meta.description, images: ["/og.png"],
  },
  description: en.meta.description,
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('veritas-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}}catch(e){}" +
              "try{var q=new URLSearchParams(location.search).get('lang');var s=localStorage.getItem('veritas.locale');var l=(q==='en'||q==='zh')?q:(s==='en'||s==='zh')?s:(/^zh\\b/i.test(navigator.language||'')?'zh':'en');document.documentElement.lang=l==='zh'?'zh-CN':'en';document.documentElement.dataset.locale=l}catch(e){}",
          }}
        />
      </head>
      <body className="relative font-sans antialiased">
        <Ambience />
        <Providers>
          <Header />
          <main className="page-width relative z-10 mx-auto min-h-[calc(100vh-8rem)] px-4 py-6">
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
