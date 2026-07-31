import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/components/theme-provider"

/** App-wide toast outlet, following the shadcn sonner wrapper: sonner's
 * theme prop takes the same "light" | "dark" | "system" values as ours. */
export function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return <Sonner theme={theme} richColors closeButton {...props} />
}
