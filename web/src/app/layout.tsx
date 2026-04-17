import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GST Tracker",
  description: "WhatsApp online activity tracker",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#075E54",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
