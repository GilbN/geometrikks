/**
 * Map control overlay with layer toggle and utilities.
 * Desktop: a collapsible panel docked top-right.
 * Mobile: a floating trigger button that opens a bottom drawer, keeping the
 * map area unobstructed.
 */

import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Check,
  Flame,
  Globe2,
  Layers,
  Loader2,
  MapPin,
  Maximize2,
  Radio,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { LayerType, MapProjection } from "./GeoMap"
import { GeoJSONFeatureStats, TopIPDTO, formatNumber } from "@/lib/api"
import type { DemoTrafficMode } from "@/lib/demo-traffic"


interface MapControlsProps {
  activeLayer: LayerType
  onLayerChange: (layer: LayerType) => void
  projection: MapProjection
  onProjectionChange: (projection: MapProjection) => void
  liveMode: boolean
  demoTrafficMode?: DemoTrafficMode
  onLiveModeChange: (enabled: boolean) => void
  routeEffectsEnabled: boolean
  onRouteEffectsChange: (enabled: boolean) => void
  routeHomeAvailable: boolean
  onFitBounds: () => void
  isLoading?: boolean
  featureStats: GeoJSONFeatureStats
  topIPs: TopIPDTO[]
  onFlyToLocation?: (lat: number, lng: number) => void
  countryOptions: string[]
  countryLabels?: Record<string, string>
  cityOptions: string[]
  selectedCountries: string[]
  selectedCities: string[]
  onCountriesChange: (values: string[]) => void
  onCitiesChange: (values: string[]) => void
}

function FilterCombobox({
  options,
  selected,
  onChange,
  placeholder,
  labels,
  mobile = false,
}: {
  options: string[]
  selected: string[]
  onChange: (values: string[]) => void
  placeholder: string
  // Optional display labels keyed by option value. The value stays the raw
  // option (e.g. a country code); only the rendered text changes.
  labels?: Record<string, string>
  // On mobile, render an inline searchable multi-select list instead of the
  // desktop typeahead popup, which is clunky on a touch screen.
  mobile?: boolean
}) {
  // Called unconditionally to satisfy the rules of hooks even though the mobile
  // branch below returns before using some of them.
  const anchor = useComboboxAnchor()
  const [query, setQuery] = useState("")
  const labelFor = (value: string) => labels?.[value] ?? value

  // Mobile: an inline searchable checkbox list (a "sheet" rendered directly in
  // the controls drawer, no nested modal). A search box filters the options and
  // each row toggles selection, so several can be picked without scrolling a
  // long option list. Selected chips sit on top for a quick overview/removal.
  if (mobile) {
    const q = query.trim().toLowerCase()
    const filtered = options.filter((o) => labelFor(o).toLowerCase().includes(q))
    // Keep selected rows visible at the top of the filtered list.
    const ordered = [...filtered].sort(
      (a, b) => Number(selected.includes(b)) - Number(selected.includes(a)),
    )
    const toggle = (o: string) =>
      onChange(
        selected.includes(o)
          ? selected.filter((x) => x !== o)
          : [...selected, o],
      )
    return (
      <div className="flex flex-col gap-1.5">
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selected.map((v) => (
              <span
                key={v}
                className="bg-muted text-foreground flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs font-medium"
              >
                {labelFor(v)}
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((x) => x !== v))}
                  aria-label={`Remove ${labelFor(v)}`}
                  className="opacity-50 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${placeholder.toLowerCase()}`}
          aria-label={`Search ${placeholder.toLowerCase()}`}
          autoComplete="off"
          // text-base (16px) keeps iOS Safari from zooming the page on focus.
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent px-2.5 text-base shadow-xs outline-none focus-visible:ring-[3px]"
        />
        <div className="border-input max-h-48 overflow-y-auto overscroll-contain rounded-md border">
          {ordered.length === 0 ? (
            <div className="text-muted-foreground px-2.5 py-2 text-xs">
              No matches
            </div>
          ) : (
            ordered.map((o) => {
              const isSel = selected.includes(o)
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => toggle(o)}
                  aria-pressed={isSel}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm",
                    isSel ? "bg-geo-cyan/10 text-geo-cyan" : "hover:bg-accent/50",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      isSel
                        ? "bg-geo-cyan border-geo-cyan text-background"
                        : "border-input",
                    )}
                  >
                    {isSel && <Check className="h-3 w-3" />}
                  </span>
                  <span className="truncate">{labelFor(o)}</span>
                </button>
              )
            })
          )}
        </div>
      </div>
    )
  }

  return (
    <Combobox
      multiple
      items={options}
      value={selected}
      onValueChange={(value) => onChange(value as string[])}
      itemToStringLabel={labelFor}
    >
      <ComboboxChips ref={anchor} className="min-h-8 px-1.5 py-1 text-xs">
        <ComboboxValue>
          {(value: string[]) => (
            <>
              {value.map((v) => (
                <ComboboxChip key={v} className="text-[10px]">
                  {labelFor(v)}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                placeholder={value.length === 0 ? placeholder : ""}
                className="text-xs"
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item} className="text-xs">
              {labelFor(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

export function MapControls({
  activeLayer,
  onLayerChange,
  projection,
  onProjectionChange,
  liveMode,
  demoTrafficMode = "off",
  onLiveModeChange,
  routeEffectsEnabled,
  onRouteEffectsChange,
  routeHomeAvailable,
  onFitBounds,
  isLoading = false,
  featureStats,
  topIPs,
  onFlyToLocation,
  countryOptions,
  countryLabels,
  cityOptions,
  selectedCountries,
  selectedCities,
  onCountriesChange,
  onCitiesChange,
}: MapControlsProps) {
  const { events, countries, cities, locations } = featureStats
  const [isExpanded, setIsExpanded] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isMobile = useIsMobile()

  // The control sections are shared between the desktop top-right panel and the
  // mobile bottom drawer so there is a single source of truth for the controls.
  const sections = (
    <>
      {/* Layer Toggle */}
      <Card className="p-2 shrink-0">
        <div className="flex flex-col gap-1">
          <ToggleGroup
            type="single"
            value={activeLayer}
            onValueChange={(value) => value && onLayerChange(value as LayerType)}
            className="flex flex-col gap-1 w-full"
            orientation="vertical"
            spacing={4}
          >
            <ToggleGroupItem
              value="heatmap"
              aria-label="Heatmap view"
              variant="outline"
              className={cn(
                "cursor-pointer w-full justify-start gap-2 px-3 data-[state=on]:bg-geo-cyan/15 data-[state=on]:text-geo-cyan data-[state=on]:border-geo-cyan/30",
                activeLayer === "heatmap" && "bg-geo-cyan/15 text-geo-cyan border-geo-cyan/30"
              )}
            >
              <Flame className="h-4 w-4" />
              <span className="text-sm font-medium">Heatmap</span>
            </ToggleGroupItem>
            <ToggleGroupItem
              value="markers"
              aria-label="Marker view"
              variant="outline"
              className={cn(
                "cursor-pointer w-full justify-start gap-2 px-3 data-[state=on]:bg-geo-cyan/15 data-[state=on]:text-geo-cyan data-[state=on]:border-geo-cyan/30",
                activeLayer === "markers" && "bg-geo-cyan/15 text-geo-cyan border-geo-cyan/30"
              )}
            >
              <MapPin className="h-4 w-4" />
              <span className="text-sm font-medium">Markers</span>
            </ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="outline"
            onClick={() => onProjectionChange(
              projection === "globe" ? "mercator" : "globe",
            )}
            aria-pressed={projection === "globe"}
            title={projection === "globe"
              ? "Switch to a flat Mercator map"
              : "Switch to an interactive globe"}
            className={cn(
              "cursor-pointer w-full justify-start gap-2 px-3",
              projection === "globe"
                && "bg-geo-cyan/15 text-geo-cyan border-geo-cyan/30",
            )}
          >
            <Globe2 className="h-4 w-4" />
            <span className="text-sm font-medium">Globe</span>
            <Badge variant="secondary" className="ml-auto text-[9px] uppercase">
              {projection === "globe" ? "on" : "off"}
            </Badge>
          </Button>
          {/* Live geo-event pulses toggle (independent of the layer choice) */}
          <Button
            variant="outline"
            onClick={() => onLiveModeChange(!liveMode)}
            aria-pressed={liveMode}
            className={cn(
              "cursor-pointer w-full justify-start gap-2 px-3",
              liveMode && "bg-geo-cyan/15 text-geo-cyan border-geo-cyan/30"
            )}
          >
            <Radio className={cn("h-4 w-4", liveMode && "animate-pulse")} />
            <span className="text-sm font-medium">
              {demoTrafficMode === "off" ? "Live" : "Demo traffic"}
            </span>
            {demoTrafficMode !== "off" && (
              <Badge variant="secondary" className="ml-auto text-[9px] uppercase">
                {demoTrafficMode}
              </Badge>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => onRouteEffectsChange(!routeEffectsEnabled)}
            aria-pressed={routeEffectsEnabled}
            disabled={!routeHomeAvailable}
            title={routeHomeAvailable
              ? "Show or hide animated network routes"
              : "No map home location could be resolved"}
            className={cn(
              "cursor-pointer w-full justify-start gap-2 px-3",
              routeEffectsEnabled && routeHomeAvailable
                && "bg-geo-cyan/15 text-geo-cyan border-geo-cyan/30",
            )}
          >
            <Sparkles className="h-4 w-4" />
            <span className="text-sm font-medium">
              {routeHomeAvailable ? "Route effects" : "Home unavailable"}
            </span>
            {routeHomeAvailable && (
              <Badge variant="secondary" className="ml-auto text-[9px] uppercase">
                {routeEffectsEnabled ? "on" : "off"}
              </Badge>
            )}
          </Button>
        </div>
      </Card>

      {/* Country / city filters */}
      <Card className="p-2 gap-1.5 shrink-0">
        <div className="text-xs font-medium text-muted-foreground">Filters</div>
        <FilterCombobox
          options={countryOptions}
          selected={selectedCountries}
          onChange={onCountriesChange}
          placeholder="Country"
          labels={countryLabels}
          mobile={isMobile}
        />
        <FilterCombobox
          options={cityOptions}
          selected={selectedCities}
          onChange={onCitiesChange}
          placeholder="City"
          mobile={isMobile}
        />
      </Card>

      {/* Fit Bounds Button */}
      <Card className="p-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={onFitBounds}
          disabled={isLoading || events === 0}
          title="Fit to data bounds"
          className="cursor-pointer"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </Card>

      {/* Status Indicator */}
      <Card className="px-3 py-2 shrink-0">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {isLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Loading...</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{formatNumber(events)} events</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{formatNumber(countries)} countries</span>
              </div>              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{formatNumber(cities)} cities</span>
              </div>              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span>{formatNumber(locations)} locations</span>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Top IPs */}
      {topIPs && topIPs.length > 0 && (
        <Card className="px-3 py-2 gap-1 shrink-0">
          <div className="text-xs font-medium text-muted-foreground mb-2">Top IPs</div>
          <div className="flex flex-col gap-1">
            {topIPs.map((ip) => (
              <button
                key={ip.ip_address}
                onClick={() => ip.location && onFlyToLocation?.(ip.location.latitude, ip.location.longitude)}
                disabled={!ip.location}
                className="flex items-center justify-between text-[10px] hover:bg-accent/50 rounded px-1 py-0.5 -mx-1 cursor-pointer disabled:cursor-default disabled:opacity-50 text-left"
              >
                <div className="font-mono truncate"><Badge variant="secondary" className="text-[10px] h-5 min-w-5 py-0 font-mono tabular-nums">{formatNumber(ip.event_count)}</Badge> {ip.ip_address}</div>
                <span className="text-muted-foreground ml-2 shrink-0">
                  {ip.location?.city ?? ip.location?.country_code ?? ""}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </>
  )

  // Mobile: a single floating trigger (bottom-right) opens a bottom drawer.
  // Placed bottom-right so it clears the lifted zoom control's row and the
  // bottom-left Event Count legend.
  if (isMobile) {
    return (
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerTrigger asChild>
          <Button
            size="icon"
            variant="outline"
            className="absolute bottom-6 right-4 z-10 bg-background cursor-pointer"
            title="Show map controls"
          >
            <Layers className="h-4 w-4" />
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Map controls</DrawerTitle>
            <DrawerDescription className="sr-only">
              Switch map layers, filter by country and city, and view statistics.
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-2 overflow-y-auto overscroll-contain px-4 pb-6">
            {sections}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  // Desktop collapsed state - single toggle button
  if (!isExpanded) {
    return (
      <div className="absolute top-4 right-4 z-10">
        <Button
          size="icon"
          variant="outline"
          className="bg-background mt-1 cursor-pointer"
          onClick={() => setIsExpanded(true)}
          title="Show map controls"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  // Desktop expanded state - full controls docked top-right
  return (
    <div className="absolute top-4 right-4 z-10 flex gap-2 max-h-[calc(100vh-2rem)] pointer-events-auto">
      {/* Scrollable controls area */}
      <div
        className="flex flex-col gap-2 p-1 overflow-y-auto overscroll-contain pointer-events-auto max-h-full max-w-[min(200px,calc(100vw-4rem))]"
        style={{ touchAction: 'pan-y' }}
      >
        {sections}
      </div>
      {/* Collapse button - inline right */}
      <Button
        size="icon"
        variant="outline"
        className="mt-1 bg-background shrink-0 p-1 self-start cursor-pointer"
        onClick={() => setIsExpanded(false)}
        title="Hide map controls"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
