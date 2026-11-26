/**
 * Where a page's filter bar takes the table's tools, such as its View menu.
 * The bar marks the spot and the table renders into it, so the card under
 * the bar needs no header of its own.
 */
import { createContext, useContext, useState } from "react"

const ToolsSlotContext = createContext<{
  element: HTMLElement | null
  setElement: (element: HTMLElement | null) => void
} | null>(null)

/** Wraps a page whose filter bar takes the table's tools. */
export function FilterBarToolsProvider({ children }: { children: React.ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  return (
    <ToolsSlotContext.Provider value={{ element, setElement }}>
      {children}
    </ToolsSlotContext.Provider>
  )
}

/** The bar's spot for a table's tools, or null where no bar shows. */
export function useFilterBarToolsSlot(): HTMLElement | null {
  return useContext(ToolsSlotContext)?.element ?? null
}

/** The spot itself, at the right end of the bar. */
export function FilterBarToolsSlot() {
  const context = useContext(ToolsSlotContext)
  return <div ref={context?.setElement} className="flex items-center gap-2 empty:hidden" />
}
