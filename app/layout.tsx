import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { Geist, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Mail Merge",
  description: "CSV-driven BYO-SMTP email mail merge.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable, jetbrainsMono.variable)}>
      <Script
        src="https://www.googletagmanager.com/gtag/js?id=G-5BLLNZ9SSD"
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-5BLLNZ9SSD');
        `}
      </Script>
      {/* Clerk rule: ClerkProvider goes INSIDE <body>, not around <html>. */}
      <body>
        <ClerkProvider appearance={{ theme: shadcn }}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
