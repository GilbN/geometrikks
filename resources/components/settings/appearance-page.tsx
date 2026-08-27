import { Monitor, Moon, Sun } from "lucide-react"

import { AccentSwatch } from "@/components/accent-toggle"
import { useTheme } from "@/components/theme-provider"
import { ACCENTS, ACCENT_LABELS, type Accent } from "@/lib/accent"
import { THEMES, type Theme } from "@/lib/theme"
import { cn } from "@/lib/utils"

const THEME_OPTIONS: Record<Theme, { label: string; description: string; icon: typeof Sun }> = {
  system: { label: "System", description: "Follow this device", icon: Monitor },
  light: { label: "Light", description: "Fjord mist", icon: Sun },
  dark: { label: "Dark", description: "Aurora night", icon: Moon },
}

const ACCENT_DESCRIPTIONS: Record<Accent, string> = {
  teal: "The default. Cold water and northern light.",
  green: "Moss on the fjord wall.",
  copper: "Forge glow, for warmer rooms.",
}

// Glass like the settings cards; selection adds the ring and a primary tint
// layered over the glass, never replacing it.
const OPTION =
  "flex min-h-16 items-center gap-3 rounded-xl bg-card/55 px-4 py-3 text-left ring-1 backdrop-blur-[2px] transition-colors pointer-coarse:min-h-11 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

function optionRing(selected: boolean) {
  return selected
    ? "ring-primary bg-[linear-gradient(var(--primary-glow),var(--primary-glow))]"
    : "ring-border hover:ring-primary/50"
}

/** Scoped accent preview: the same trick as the header swatch, grown into a
 * little card so the accent is seen against a surface, not just as a dot. */
function AccentPreview({ accent }: { accent: Accent }) {
  return (
    <span
      data-accent={accent}
      aria-hidden
      className="grid h-12 w-20 shrink-0 grid-cols-[0.75rem_1fr] overflow-hidden rounded-md bg-background ring-1 ring-border"
    >
      <span className="bg-sidebar" />
      <span className="flex flex-col gap-1 p-1.5">
        <span
          className="h-1.5 w-8 rounded-full"
          style={{ background: "oklch(var(--brand-l) var(--brand-c) var(--brand-h))" }}
        />
        <span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
        <span className="h-1 w-6 rounded-full bg-muted-foreground/30" />
      </span>
    </span>
  )
}

export function AppearancePage() {
  const { theme, setTheme, accent, setAccent } = useTheme()

  return (
    <div className="space-y-8">
      <section aria-labelledby="theme-heading" className="space-y-3">
        <div className="space-y-1">
          <h2 id="theme-heading" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Theme
          </h2>
          <p className="text-[13px] text-muted-foreground">
            System follows the device and switches live when it does.
          </p>
        </div>
        <div role="group" aria-label="Theme" className="grid gap-2 sm:grid-cols-3">
          {THEMES.map((value) => {
            const option = THEME_OPTIONS[value]
            const selected = theme === value
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => setTheme(value)}
                className={cn(OPTION, optionRing(selected))}
              >
                <option.icon className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
                <span>
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section aria-labelledby="accent-heading" className="space-y-3">
        <div className="space-y-1">
          <h2 id="accent-heading" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Accent
          </h2>
          <p className="text-[13px] text-muted-foreground">
            Colors the brand mark, active navigation, links and the map's live routes. Charts keep their own palette.
          </p>
        </div>
        <div role="group" aria-label="Accent" className="grid gap-2 sm:grid-cols-3">
          {ACCENTS.map((value) => {
            const selected = accent === value
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => setAccent(value)}
                className={cn(OPTION, optionRing(selected))}
              >
                <AccentPreview accent={value} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <AccentSwatch accent={value} />
                    {ACCENT_LABELS[value]}
                  </span>
                  <span className="block text-xs text-muted-foreground">{ACCENT_DESCRIPTIONS[value]}</span>
                </span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
