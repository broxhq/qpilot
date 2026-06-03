import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import './globals.css';

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "QA Agent",
  description: "Run manual test cases with an AI agent in a real browser",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("dark", sans.variable, mono.variable)} suppressHydrationWarning>
      <body className="font-sans min-h-screen">
        {children}
      </body>
    </html>
  );
}
