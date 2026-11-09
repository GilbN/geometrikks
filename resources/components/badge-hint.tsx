import type { KeyboardEvent, ReactElement } from "react"
import { Slot } from "radix-ui"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useMediaQuery } from "@/hooks/use-media-query"

const NO_HOVER_QUERY = "(hover: none), (pointer: coarse)"

function openOnKey(event: KeyboardEvent<HTMLElement>) {
  // A focused link inside the badge keeps its own Enter.
  if (event.target !== event.currentTarget) return
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    event.currentTarget.click()
  }
}

/**
 * Explains a badge on every device. Touch browsers show neither a `title`
 * nor a Radix tooltip, so where nothing can hover a tap opens the text.
 */
export function BadgeHint({
  hint,
  hover = "title",
  tappable = true,
  holdsLink = false,
  children,
}: {
  hint: string
  hover?: "title" | "tooltip"
  /** Off when the badge sits inside a button, whose tap must still work. */
  tappable?: boolean
  /** A button role would hide a link inside the badge from screen readers. */
  holdsLink?: boolean
  children: ReactElement
}) {
  const noHover = useMediaQuery(NO_HOVER_QUERY)
  if (noHover && tappable) {
    return (
      <Popover>
        <PopoverTrigger asChild role={holdsLink ? undefined : "button"} tabIndex={0} data-badge-hint="" onKeyDown={openOnKey}>
          {children}
        </PopoverTrigger>
        <PopoverContent
          collisionPadding={8}
          sideOffset={6}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="w-fit max-w-[min(20rem,calc(100vw-1rem))] rounded-md px-3 py-2 text-xs leading-snug shadow-lg ring-border"
        >
          {hint}
        </PopoverContent>
      </Popover>
    )
  }
  if (hover === "tooltip") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="max-w-xs">{hint}</TooltipContent>
      </Tooltip>
    )
  }
  return <Slot.Root title={hint}>{children}</Slot.Root>
}
