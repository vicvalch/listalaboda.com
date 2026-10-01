import type { Metadata } from "next";

import { DEFAULT_LOCALE, getMessages } from "@/lib/i18n";
import "./globals.css";

const messages = getMessages();

export const metadata: Metadata = {
  title: messages.metadata.title,
  description: messages.metadata.description,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang={DEFAULT_LOCALE} className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
