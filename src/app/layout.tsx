import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LedgerMatch — A clearer close",
  description: "A synthetic finance operations demo. Reconcile invoices and payments, resolve exceptions, and follow every decision.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
