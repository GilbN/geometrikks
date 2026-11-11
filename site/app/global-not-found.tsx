import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body>
        <h1>Page not found</h1>
        <p>
          <a href="/docs/">Go to the docs</a>
        </p>
      </body>
    </html>
  );
}
