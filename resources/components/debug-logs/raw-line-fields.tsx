import { Fragment } from "react"
import { Badge } from "@/components/ui/badge"
import type { RawLineFields } from "@/lib/api"
import { cn } from "@/lib/utils"
import { breakSegments, rawLineSections } from "./raw-line-sections"

function Breakable({ text, isKey = false }: { text: string; isKey?: boolean }) {
  return breakSegments(text, { key: isKey }).map((segment, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {segment}
    </Fragment>
  ))
}

/** One framed block like the Raw view, so the tabs swap like for like. The
 * subgrid shares one key column across every group, as wide as the longest
 * key and its tag up to 45%, which lines the tags up on its right edge. */
export function RawLineFieldsView({ rawFields }: { rawFields: RawLineFields }) {
  return (
    <div className="grid grid-cols-[fit-content(45%)_minmax(0,1fr)] gap-x-4 rounded-md border bg-muted/50 px-3 text-xs">
      {rawLineSections(rawFields).map((section, sectionIndex) => (
        <section
          key={section.title}
          aria-label={section.title}
          className={cn("col-span-2 grid grid-cols-subgrid", sectionIndex > 0 && "border-t")}
        >
          <h4 className="col-span-2 flex items-baseline gap-1.5 pt-2.5 pb-1 font-medium text-muted-foreground">
            {section.title}
            <span className="font-normal tabular-nums text-muted-foreground/70">{section.fields.length}</span>
          </h4>
          <dl className="col-span-2 grid grid-cols-subgrid">
            {section.fields.map((field, index) => (
              <div
                key={index}
                className="col-span-2 grid grid-cols-subgrid border-t border-border/40 py-1.5 last:pb-2.5"
              >
                <dt className="flex min-w-0 flex-wrap content-start items-start justify-between gap-x-1.5 font-mono text-muted-foreground">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <Breakable text={field.key} isKey />
                  </span>
                  {field.storedAs && (
                    <>
                      <span className="sr-only"> stored as </span>
                      <Badge
                        variant="outline"
                        className="ml-auto mt-px h-[18px] rounded-[4px] border-primary/35 bg-primary/10 px-[5px] py-0 font-sans text-[10.5px] font-normal text-primary"
                      >
                        {field.storedAs}
                      </Badge>
                    </>
                  )}
                </dt>
                <dd
                  className={cn(
                    "min-w-0 font-mono [overflow-wrap:anywhere]",
                    field.value === "" && "font-sans text-muted-foreground italic",
                  )}
                >
                  {field.value === "" ? "empty" : <Breakable text={field.value} />}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
