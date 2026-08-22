/**
 * Map control overlay: one bounded panel with labeled sections, in this
 * order: Visualization, Live, Live overlays, Filters, View, Summary, Top IPs.
 * Desktop: a collapsible MapOverlay docked top-right.
 * Mobile: a trigger button portaled into the top header bar (next to the
 * time-range toolbar) that opens a bottom drawer with the same sections.
 */

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { MapOverlay } from "./MapOverlay"
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
import { FilterCombobox } from "@/components/ui/filter-combobox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Activity,
  Flame,
  Globe2,
  Home,
  Loader2,
  MapPin,
  Maximize2,
  Radio,
  SlidersHorizontal,
  Sparkles,
  ShieldBan,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { FRAME_LABEL } from "@/components/data/frame"
import type { LayerType, MapProjection } from "./GeoMap"
import { GeoJSONFeatureStats, TopIPDTO, formatNumber } from "@/lib/api"
import type { DemoTrafficMode } from "@/lib/demo-traffic"
import type { LiveOverlayPreferences } from "@/lib/live-overlays"


interface MapControlsProps {
  activeLayer: LayerType
  onLayerChange: (layer: LayerType) => void
  projection: MapProjection
  onProjectionChange: (projection: MapProjection) => void
  liveMode: boolean
  demoTrafficMode?: DemoTrafficMode
  onLiveModeChange: (enabled: boolean) => void
  liveOverlays: LiveOverlayPreferences
  onLiveOverlayChange: (key: keyof LiveOverlayPreferences, enabled: boolean) => void
  routeEffectsEnabled: boolean
  onRouteEffectsChange: (enabled: boolean) => void
  routeHomeAvailable: boolean
  homeMarkerEnabled: boolean
  onHomeMarkerChange: (enabled: boolean) => void
  /** CrowdSec integration configured; hides the overlay toggle when false. */
  bannedOverlayAvailable: boolean
  bannedOverlayEnabled: boolean
  onBannedOverlayChange: (enabled: boolean) => void
  bannedCount: number
  /** Banned-locations fetch in flight; shows a spinner on the toggle. */
  bannedOverlayLoading?: boolean
  onFitBounds: () => void
  /** Fly to the resolved map home location; button hidden when routeHomeAvailable is false. */
  onGoHome?: () => void
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
  sourceOptions: string[]
  selectedSources: string[]
  onSourcesChange: (values: string[]) => void
  sourcesLoading?: boolean
}

function Section({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1 border-b border-border/50 pb-2.5 last:border-0 last:pb-0">
      {label && <h3 className={cn(FRAME_LABEL, "mb-1.5")}>{label}</h3>}
      {children}
    </section>
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
  liveOverlays,
  onLiveOverlayChange,
  routeEffectsEnabled,
  onRouteEffectsChange,
  routeHomeAvailable,
  homeMarkerEnabled,
  onHomeMarkerChange,
  bannedOverlayAvailable,
  bannedOverlayEnabled,
  onBannedOverlayChange,
  bannedCount,
  bannedOverlayLoading = false,
  onFitBounds,
  onGoHome,
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
  sourceOptions,
  selectedSources,
  onSourcesChange,
  sourcesLoading = false,
}: MapControlsProps) {
  const { events, countries, cities, locations } = featureStats
  const [isExpanded, setIsExpanded] = useState(true)
  const activeFilterCount =
    (selectedCountries.length ? 1 : 0) + (selectedCities.length ? 1 : 0) + (selectedSources.length ? 1 : 0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isMobile = useIsMobile()

  // The header slot only exists after the root layout commits, so resolve it
  // post-mount rather than during render.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHeaderSlot(document.getElementById("header-actions-slot"))
  }, [])

  const viewActions = (
    <div className="flex gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onFitBounds}
        disabled={isLoading || events === 0}
        title="Fit to data bounds"
        className="cursor-pointer pointer-coarse:size-10"
      >
        <Maximize2 className="h-4 w-4" />
        <span className="sr-only">Fit to data bounds</span>
      </Button>
      {routeHomeAvailable && onGoHome && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onGoHome}
          title="Go to home location"
          className="cursor-pointer pointer-coarse:size-10"
        >
          <Home className="h-4 w-4" />
          <span className="sr-only">Go to home location</span>
        </Button>
      )}
    </div>
  )

  // The control sections are shared between the desktop top-right panel and the
  // mobile bottom drawer so there is a single source of truth for the controls.
  const sections = (
    <>
      <Section>
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
                "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10 data-[state=on]:bg-primary/15 data-[state=on]:text-primary data-[state=on]:border-primary/30",
                activeLayer === "heatmap" && "bg-primary/15 text-primary border-primary/30"
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
                "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10 data-[state=on]:bg-primary/15 data-[state=on]:text-primary data-[state=on]:border-primary/30",
                activeLayer === "markers" && "bg-primary/15 text-primary border-primary/30"
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
              "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10",
              projection === "globe"
                && "bg-primary/15 text-primary border-primary/30",
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
              "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10",
              liveMode && "bg-primary/15 text-primary border-primary/30"
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
              "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10",
              routeEffectsEnabled && routeHomeAvailable
                && "bg-primary/15 text-primary border-primary/30",
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
          {routeHomeAvailable && (
            <Button
              variant="outline"
              onClick={() => onHomeMarkerChange(!homeMarkerEnabled)}
              aria-pressed={homeMarkerEnabled}
              title="Show a beacon at the server home location"
              className={cn(
                "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10",
                homeMarkerEnabled && "bg-primary/15 text-primary border-primary/30",
              )}
            >
              <Home className="h-4 w-4" />
              <span className="text-sm font-medium">Home marker</span>
              <Badge variant="secondary" className="ml-auto text-[9px] uppercase">
                {homeMarkerEnabled ? "on" : "off"}
              </Badge>
            </Button>
          )}
          {bannedOverlayAvailable && (
            <Button
              variant="outline"
              onClick={() => onBannedOverlayChange(!bannedOverlayEnabled)}
              aria-pressed={bannedOverlayEnabled}
              title="Show banned IPs seen in your traffic within the selected time range as red markers"
              className={cn(
                "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10",
                bannedOverlayEnabled && "bg-red-500/15 text-red-400 border-red-500/30",
              )}
            >
              {bannedOverlayLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldBan className="h-4 w-4" />
              )}
              <span className="text-sm font-medium">Banned IPs</span>
              <Badge variant="secondary" className="ml-auto text-[9px] uppercase">
                {bannedOverlayEnabled
                  ? bannedOverlayLoading
                    ? "…"
                    : bannedCount.toLocaleString()
                  : "off"}
              </Badge>
            </Button>
          )}
        </div>
      </Section>

      {/* The rail only mounts at md and up; below that the vitals pill is the
          sole entry point into live data, so this section would offer a
          switch that controls nothing. */}
      {liveMode && !isMobile && (
        <Section label="Live overlays">
          {([
            { key: "rail" as const, label: "Live rail", icon: Activity },
          ]).map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              variant="outline"
              onClick={() => onLiveOverlayChange(key, !liveOverlays[key])}
              aria-pressed={liveOverlays[key]}
              className={cn(
                "cursor-pointer w-full justify-start gap-2 px-3 pointer-coarse:h-10",
                liveOverlays[key] && "bg-primary/15 text-primary border-primary/30",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {/* The label truncates rather than pushing the indicator past
                  the button border on narrow panels. */}
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{label}</span>
              {/* State dot, same vocabulary as the sidebar's live-ingestion
                  dot: lit cyan while the overlay is shown. An on/off text
                  badge does not fit next to the longest label here. */}
              <span
                aria-hidden
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  liveOverlays[key]
                    ? "bg-primary shadow-[0_0_6px_var(--primary)]"
                    : "bg-muted-foreground/40",
                )}
              />
            </Button>
          ))}
        </Section>
      )}

      {/* Country / city / source filters, one per row. */}
      <Section label="Filters">
        <FilterCombobox
          label="Country"
          options={countryOptions}
          selected={selectedCountries}
          onChange={onCountriesChange}
          labelFor={(code) => countryLabels?.[code] ?? code}
          forceInline={isMobile}
          className="w-full justify-between"
        />
        <FilterCombobox
          label="City"
          options={cityOptions}
          selected={selectedCities}
          onChange={onCitiesChange}
          forceInline={isMobile}
          className="w-full justify-between"
        />
        {(sourceOptions.length >= 2 || selectedSources.length > 0) && (
          <FilterCombobox
            label="Source"
            options={sourceOptions}
            selected={selectedSources}
            onChange={onSourcesChange}
            loading={sourcesLoading}
            emptyText="No sources recorded"
            forceInline={isMobile}
            className="w-full justify-between"
          />
        )}
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start px-2 pointer-coarse:h-10"
            onClick={() => {
              onCountriesChange([])
              onCitiesChange([])
              onSourcesChange([])
            }}
          >
            Clear filters
          </Button>
        )}
      </Section>

      {isMobile && <Section>{viewActions}</Section>}

      <Section>
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
      </Section>

      {topIPs && topIPs.length > 0 && (
        <Section label="Top IPs">
          <div className="flex flex-col gap-1">
            {topIPs.map((ip) => (
              <button
                key={ip.ipAddress}
                onClick={() => ip.location && onFlyToLocation?.(ip.location.latitude, ip.location.longitude)}
                disabled={!ip.location}
                className="flex items-center justify-between text-[10px] hover:bg-foreground/[0.07] rounded px-1 py-0.5 -mx-1 cursor-pointer disabled:cursor-default disabled:opacity-50 text-left"
              >
                <div className="font-mono truncate"><Badge variant="secondary" className="text-[10px] h-5 min-w-5 py-0 font-mono tabular-nums">{formatNumber(ip.eventCount)}</Badge> {ip.ipAddress}</div>
                <span className="text-muted-foreground ml-2 shrink-0">
                  {ip.location?.city ?? ip.location?.countryCode ?? ""}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </>
  )

  // Mobile: a trigger in the top header bar (same icon as the desktop panel
  // toggle) opens a bottom drawer. Portaled into the header's action slot so
  // it sits with the toolbar buttons instead of floating over the map.
  if (isMobile) {
    return (
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        {headerSlot && createPortal(
          <DrawerTrigger asChild>
            <Button
              size="icon-sm"
              variant="outline"
              className="shrink-0 pointer-coarse:size-10 cursor-pointer"
              title="Show map controls"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="sr-only">Map Controls</span>
            </Button>
          </DrawerTrigger>,
          headerSlot,
        )}
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Map controls</DrawerTitle>
            <DrawerDescription className="sr-only">
              Switch map layers, filter by country and city, and view statistics.
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-6">
            {sections}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  // Desktop collapsed state: one button, with a dot while filters are active
  // so a filtered map is never mistaken for the whole dataset.
  if (!isExpanded) {
    return (
      <div className="absolute top-4 right-4 z-10">
        <Button
          size="icon"
          variant="outline"
          className="relative bg-background/85 backdrop-blur cursor-pointer"
          onClick={() => setIsExpanded(true)}
          title="Show map controls"
          aria-label={
            activeFilterCount > 0
              ? `Show map controls, ${activeFilterCount} active filter groups`
              : "Show map controls"
          }
        >
          <SlidersHorizontal className="h-4 w-4" />
          {activeFilterCount > 0 && (
            <span aria-hidden className="absolute -top-1 -right-1 size-2.5 rounded-full bg-primary ring-2 ring-background" />
          )}
        </Button>
      </div>
    )
  }

  // Desktop expanded state: one bounded overlay docked top-right. The height
  // cap leaves room beneath it for the MapLibre navigation controls docked
  // bottom-right (issue #53).
  return (
    <MapOverlay
      placement="top-right"
      role="complementary"
      aria-label="Map controls"
      className="w-[min(220px,calc(100vw-4rem))] max-h-[calc(100%-9rem)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border/50 py-1.5 pl-3 pr-1.5">
        <h2 className={FRAME_LABEL}>Map controls</h2>
        <div className="flex items-center gap-0.5">
          {viewActions}
          <Button
            size="icon-sm"
            variant="ghost"
            className="cursor-pointer"
            onClick={() => setIsExpanded(false)}
            title="Hide map controls"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Hide map controls</span>
          </Button>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-col gap-2.5 overflow-y-auto overscroll-contain p-3"
        style={{ touchAction: "pan-y" }}
      >
        {sections}
      </div>
    </MapOverlay>
  )
}
