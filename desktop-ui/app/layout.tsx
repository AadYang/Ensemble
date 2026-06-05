import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ensemble",
  description: "Many minds. One workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full overflow-hidden flex flex-col">{children}</body>
    </html>
  );
}
