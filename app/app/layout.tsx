import type { ReactNode } from "react";

export const metadata = {
  title: "sift — Contract Clause Review",
  description: "Grounded contract clause review copilot",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
