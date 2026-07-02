import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "sift — Contract Clause Review",
  description: "Grounded contract clause review copilot",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
