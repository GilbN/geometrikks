import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** One-shot check for the mobile breakpoint (matches useIsMobile's 768px).
 * For non-reactive contexts like useState initializers; components that must
 * re-render on resize should use the useIsMobile hook instead. */
export function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
}
