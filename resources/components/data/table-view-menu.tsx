/**
 * The View menu in a table's header: row density, the column layout where a
 * table has a combined one, the time format shared by every table, and the
 * visible fields. Density and layout are per table, kept by useTableView.
 */
import { useState } from "react"
import { Columns3, SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  formatTableTime,
  useTimeFormat,
  type ColumnLayout,
  type RowDensity,
  type TimeFormat,
} from "@/lib/table-view"

const LABEL_CLASS = "text-[11px] font-semibold uppercase tracking-[0.08em]"

function Hint({ children }: { children: string }) {
  return <span className="ml-auto pl-4 text-xs text-muted-foreground">{children}</span>
}

export interface ViewMenuField {
  key: string
  label: string
}

export function TableViewMenu({
  density,
  onDensityChange,
  layout,
  onLayoutChange,
  layoutHint = "Request, Client, Location",
  showTime = true,
  fields,
  visible,
  onToggleField,
  onReset,
  canReset,
}: {
  density: RowDensity
  onDensityChange: (density: RowDensity) => void
  /** Left out for a table without a combined layout. */
  layout?: ColumnLayout
  onLayoutChange?: (layout: ColumnLayout) => void
  layoutHint?: string
  showTime?: boolean
  /** Left out for a table with a fixed set of columns. */
  fields?: readonly ViewMenuField[]
  visible?: ReadonlySet<string>
  onToggleField?: (key: string) => void
  onReset: () => void
  canReset: boolean
}) {
  const [timeFormat, setTimeFormat] = useTimeFormat()
  // Taken when the menu opens, so the examples hold still while rows stream in.
  const [now, setNow] = useState(() => new Date())
  return (
    <DropdownMenu onOpenChange={(open) => open && setNow(new Date())}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <SlidersHorizontal className="mr-1 h-3.5 w-3.5" /> View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-auto min-w-56">
        <DropdownMenuLabel className={LABEL_CLASS}>Rows</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Rows"
          value={density}
          onValueChange={(value) => onDensityChange(value as RowDensity)}
        >
          <DropdownMenuRadioItem value="comfortable" onSelect={(e) => e.preventDefault()}>
            Comfortable
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="compact" onSelect={(e) => e.preventDefault()}>
            Compact
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {layout && onLayoutChange && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className={LABEL_CLASS}>Columns</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              aria-label="Columns"
              value={layout}
              onValueChange={(value) => onLayoutChange(value as ColumnLayout)}
            >
              <DropdownMenuRadioItem value="combined" onSelect={(e) => e.preventDefault()}>
                Combined
                <Hint>{layoutHint}</Hint>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="separate" onSelect={(e) => e.preventDefault()}>
                Separate
                <Hint>One field each</Hint>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}
        {showTime && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className={LABEL_CLASS}>Time</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              aria-label="Time"
              value={timeFormat}
              onValueChange={(value) => setTimeFormat(value as TimeFormat)}
            >
              <DropdownMenuRadioItem value="short24" onSelect={(e) => e.preventDefault()}>
                <span className="tabular-nums">{formatTableTime(now, "short24", now)}</span>
                <Hint>24-hour</Hint>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="browser" onSelect={(e) => e.preventDefault()}>
                <span className="tabular-nums">{formatTableTime(now, "browser", now)}</span>
                <Hint>Browser</Hint>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}
        <DropdownMenuSeparator />
        {fields && visible && onToggleField && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Columns3 className="text-muted-foreground" />
              Visible fields
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              collisionPadding={8}
              className="max-h-(--radix-dropdown-menu-content-available-height) min-w-44 overflow-y-auto"
            >
              <DropdownMenuLabel className={LABEL_CLASS}>Visible fields</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {fields.map((field) => (
                <DropdownMenuCheckboxItem
                  key={field.key}
                  checked={visible.has(field.key)}
                  onCheckedChange={() => onToggleField(field.key)}
                  onSelect={(e) => e.preventDefault()}
                  disabled={visible.has(field.key) && visible.size === 1}
                >
                  {field.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem inset={fields ? true : undefined} disabled={!canReset} onSelect={onReset}>
          Reset view
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
