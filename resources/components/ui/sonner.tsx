import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/components/theme-provider"

/** App-wide toast outlet, following the shadcn sonner wrapper: sonner's
 * theme prop takes the same "light" | "dark" | "system" values as ours.
 * The `toaster` class scopes the rules in main.css that give every toast
 * the same glass surface as the map controls and popups. */
export function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return <Sonner theme={theme} closeButton className="toaster" {...props} />
}
