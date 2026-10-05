import type { Metadata, Viewport } from "next";
import "./globals.css";
import { IdentityProvider } from "@/components/identity";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Sakshi",
  description: "Forensic, post-quantum document distribution: every decrypted copy is unique and every decryption is witnessed on an air-gapped ledger.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#121314" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        {/* Apply a saved theme before paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("sakshi.theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <IdentityProvider>
          <Shell>{children}</Shell>
        </IdentityProvider>
      </body>
    </html>
  );
}
