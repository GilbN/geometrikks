import { Palette } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/theme-provider"
import { ACCENTS, type Accent, parseAccent } from "@/lib/accent"

const LABELS: Record<Accent, string> = {
  teal: "Aurora teal",
  green: "Fjord green",
  copper: "Ember copper",
}

/** Swatch under its own data-accent. --primary is resolved on <html>, so the
 * color is composed from the --brand-* parts here, where the scoped accent
 * overrides them; it previews exactly what choosing it will do. */
function Swatch({ accent }: { accent: Accent }) {
  return (
    <span
      data-accent={accent}
      aria-hidden
      className="inline-block size-3 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
      style={{ background: "oklch(var(--brand-l) var(--brand-c) var(--brand-h))" }}
    />
  )
}

export function AccentToggle() {
  const { accent, setAccent } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" className="shrink-0 pointer-coarse:size-10">
          <Palette className="h-[1.2rem] w-[1.2rem]" />
          <span className="sr-only">Choose accent color</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={accent} onValueChange={(v) => setAccent(parseAccent(v))}>
          {ACCENTS.map((a) => (
            <DropdownMenuRadioItem key={a} value={a} className="gap-2">
              <Swatch accent={a} />
              {LABELS[a]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
