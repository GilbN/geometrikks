/**
 * Per-chart View and Scale menu for a SignalPanel header. Chips on the
 * trigger name any non-default choice, so the state shows without opening
 * the menu, and the accessible name carries the same text.
 */
import { useId } from "react"
import { SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CHART_SCALE_LABELS,
  chartOptionChips,
  chartOptionsLabel,
  type ChartOptionsSpec,
  type ChartOptionsState,
  type ChartScale,
} from "@/lib/chart-options"

export function ChartOptionsMenu({
  title,
  spec,
  options,
}: {
  title: string
  spec: ChartOptionsSpec
  options: ChartOptionsState
}) {
  const viewLabelId = useId()
  const scaleLabelId = useId()
  const chips = chartOptionChips(options)
  const { view } = options

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={chartOptionsLabel(title, chips)}
          className="gap-1 px-1.5 text-muted-foreground"
        >
          {chips.map((chip) => (
            <span key={chip} className="rounded-md bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
              {chip}
            </span>
          ))}
          <SlidersHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared content matches the trigger width; this trigger is tiny. */}
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel id={viewLabelId}>View</DropdownMenuLabel>
        <DropdownMenuRadioGroup aria-labelledby={viewLabelId} value={view.id} onValueChange={options.setView}>
          {spec.views.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel id={scaleLabelId}>Scale</DropdownMenuLabel>
        {view.scales.length > 1 ? (
          <DropdownMenuRadioGroup
            aria-labelledby={scaleLabelId}
            value={options.scale}
            onValueChange={(value) => options.setScale(value as ChartScale)}
          >
            {view.scales.map((scale) => (
              <DropdownMenuRadioItem key={scale} value={scale} className="flex-col items-start gap-0">
                {CHART_SCALE_LABELS[scale]}
                {view.scaleHints?.[scale] && (
                  <span className="text-xs text-muted-foreground">{view.scaleHints[scale]}</span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {view.fixedScaleNote ?? CHART_SCALE_LABELS[view.scales[0]]}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Header notes that explain what the y-axis is hiding or substituting. */
export function ScaleNotes({ clip, zerosRaised }: { clip: string | null; zerosRaised: number }) {
  return (
    <>
      {clip != null && <span>y-axis clipped at {clip}</span>}
      {zerosRaised > 0 && <span>zeros drawn at the bottom edge</span>}
    </>
  )
}
