import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider, type RootProviderProps } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import SearchDialog, { type SearchDialogProps } from "@/components/docs/SearchDialog";
import { baseOptions } from "@/lib/layout.shared";
import { plan, source } from "@/lib/source";
import "./docs.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://geometrikks.dev"),
  title: { template: "%s | GeoMetrikks docs", default: "GeoMetrikks docs" },
};

const searchDialogOptions: Partial<SearchDialogProps> = { latestServed: plan.latest !== null };

// RootProvider types its search slot for the default dialog, so a dialog with its own props needs the cast.
const search = { SearchDialog, options: searchDialogOptions } as RootProviderProps["search"];

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={search}>
          <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
