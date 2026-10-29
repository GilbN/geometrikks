import { Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ResponsiveRadioMenu } from "@/components/responsive-radio-menu"
import { useTheme } from "@/components/theme-provider"
import { parseTheme } from "@/lib/theme"

const SCHEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const

export function ModeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <ResponsiveRadioMenu
      title="Color scheme"
      description="Choose light, dark or the system setting."
      trigger={
        <Button variant="outline" size="icon-sm" className="shrink-0">
          <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      }
      groups={[{ label: "Color scheme", value: theme, options: SCHEMES, onValueChange: (value) => setTheme(parseTheme(value)) }]}
    />
  )
}
