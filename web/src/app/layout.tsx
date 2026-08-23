import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Balkania TMS",
    template: "%s · Balkania TMS",
  },
  description:
    "Transport management for Balkania: dispatch planning, live fleet tracking, and automated customer alerts.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        {/* Variable axes, not a single instance — `.icon-filled` needs FILL 1.
            `display=block` keeps the ligature text from flashing before the
            icon font arrives. The App Router root layout is the correct place
            for this link; the lint rule below only applies to `pages/`. */}
        {/* `block` over the linted-for `optional`/`swap` on purpose: this is an
            icon font, and a fallback swap renders the raw ligature text
            ("local_shipping") in place of every icon. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
          rel="stylesheet"
        />
      </head>
      <body className="bg-canvas font-sans text-body text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
