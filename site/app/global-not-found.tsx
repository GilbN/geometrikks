import type { Metadata } from "next";
import { Mark } from "@/components/brand/Mark";
import { Wordmark } from "@/components/brand/Wordmark";
import "./docs/docs.css";

export const metadata: Metadata = {
  title: "Page not found",
  metadataBase: new URL("https://geometrikks.dev"),
};

// The docs store the reader's theme with next-themes under this key; RootProvider is not loaded here.
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function GlobalNotFound() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-screen flex-col items-center justify-center gap-6 bg-fd-background px-6 text-center text-fd-foreground">
        <a href="/" className="flex items-center gap-2.5 text-fd-foreground no-underline" aria-label="GeoMetrikks">
          <Mark size={32} />
          <Wordmark className="text-lg" />
        </a>
        <h1 className="text-3xl font-semibold">Page not found</h1>
        <p className="text-fd-muted-foreground">This page does not exist, or it has moved.</p>
        <p className="flex gap-4">
          <a href="/docs/" className="font-medium text-fd-primary underline underline-offset-4">
            Go to the docs
          </a>
          <a href="/" className="font-medium text-fd-primary underline underline-offset-4">
            Go to the home page
          </a>
        </p>
      </body>
    </html>
  );
}
