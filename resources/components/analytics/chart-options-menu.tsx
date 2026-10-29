/**
 * Per-chart View and Scale menu for a SignalPanel header. Chips on the
 * trigger name any non-default choice, so the state shows without opening
 * the menu, and the accessible name carries the same text.
 */
import { SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResponsiveRadioMenu } from "@/components/responsive-radio-menu"
import { useIsMobile } from "@/hooks/use-mobile"
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
  const isMobile = useIsMobile()
  const chips = chartOptionChips(options)
  const { view } = options

  return (
    <ResponsiveRadioMenu
      title={title}
      description="Choose how this chart draws its data and scales its y-axis."
      // The shared content matches the trigger width; this trigger is tiny.
      contentClassName="w-56"
      trigger={
        <Button
          type="button"
          variant={isMobile ? "outline" : "ghost"}
          size={isMobile ? "default" : "xs"}
          aria-label={chartOptionsLabel(title, chips)}
          className={
            isMobile
              ? "min-w-9 gap-1.5 px-2 text-muted-foreground pointer-coarse:min-w-10"
              : "gap-1 px-1.5 text-muted-foreground pointer-coarse:min-w-10"
          }
        >
          {chips.map((chip) => (
            <span key={chip} className="rounded-md bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
              {chip}
            </span>
          ))}
          <SlidersHorizontal aria-hidden />
        </Button>
      }
      groups={[
        {
          label: "View",
          value: view.id,
          options: spec.views.map((item) => ({ value: item.id, label: item.label })),
          onValueChange: options.setView,
        },
        {
          label: "Scale",
          value: options.scale,
          options: view.scales.map((scale) => ({
            value: scale,
            label: CHART_SCALE_LABELS[scale],
            hint: view.scaleHints?.[scale],
          })),
          onValueChange: (value) => options.setScale(value as ChartScale),
          stacked: true,
          note: view.scales.length > 1 ? undefined : (view.fixedScaleNote ?? CHART_SCALE_LABELS[view.scales[0]]),
        },
      ]}
    />
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
