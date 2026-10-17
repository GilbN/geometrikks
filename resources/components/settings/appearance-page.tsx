import { Monitor, Moon, Sun } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { THEMES, type Theme } from "@/lib/theme"
import { cn } from "@/lib/utils"

const THEME_OPTIONS: Record<Theme, { label: string; description: string; icon: typeof Sun }> = {
  system: { label: "System", description: "Follow this device", icon: Monitor },
  light: { label: "Light", description: "Fjord mist", icon: Sun },
  dark: { label: "Dark", description: "Your dark appearance", icon: Moon },
}

// Glass like the settings cards; selection adds the ring and a primary tint
// layered over the glass, never replacing it.
const OPTION =
  "flex min-h-16 items-center gap-3 rounded-xl bg-glass-card px-4 py-3 text-left ring-1 backdrop-blur-[2px] transition-colors pointer-coarse:min-h-11 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

function optionRing(selected: boolean) {
  return selected
    ? "ring-primary bg-[linear-gradient(var(--primary-glow),var(--primary-glow))]"
    : "ring-border hover:ring-primary/50"
}

export function AppearancePage() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="space-y-8">
      <section aria-labelledby="theme-heading" className="space-y-3">
        <div className="space-y-1">
          <h2 id="theme-heading" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Color mode
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
    </div>
  )
}
