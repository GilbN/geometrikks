import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { source } from "@/lib/source";
import "./docs.css";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }}>
          <DocsLayout tree={source.getPageTree()} nav={{ title: "GeoMetrikks" }}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
