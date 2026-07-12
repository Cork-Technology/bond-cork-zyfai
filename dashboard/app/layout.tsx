import type { Metadata } from "next";
import { headers } from "next/headers";
import { Inter, Libre_Baskerville, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Nav } from "@/components/nav";
import { Header } from "@/components/header";

const inter = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

const libreBaskerville = Libre_Baskerville({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Bond × Cork × Zyfai — Hackathon Dashboard",
  description: "Observer dashboard for the bond.credit × Cork × Zyfai hackathon demo",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookies = (await headers()).get("cookie");

  return (
    <html
      lang="en"
      className={`${inter.variable} ${libreBaskerville.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col lg:flex-row bg-background text-foreground">
        <Providers cookies={cookies}>
          <Nav />
          <main className="flex-1 overflow-auto p-4 lg:p-8">
            <Header />
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
