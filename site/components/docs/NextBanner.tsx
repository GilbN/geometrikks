import Link from "next/link";

export function NextBanner({ latestHref }: { latestHref: string | null }) {
  return (
    <div
      role="note"
      className="mb-2 rounded-lg border border-fd-primary/40 bg-fd-primary/10 px-4 py-3 text-sm text-fd-foreground"
    >
      Next: these pages describe unreleased changes on the develop branch.
      {latestHref !== null && (
        <>
          {" "}
          <Link href={latestHref} className="font-medium text-fd-primary underline underline-offset-4">
            Read the docs for the current release
          </Link>
        </>
      )}
    </div>
  );
}
