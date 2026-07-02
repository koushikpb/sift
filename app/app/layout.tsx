import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { cn } from "../src/lib/cn";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata = {
  title: "sift — Contract Clause Review",
  description: "Grounded contract clause review copilot",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={cn(inter.className, "min-h-screen bg-background text-foreground antialiased")}>
        {children}
      </body>
    </html>
  );
}
