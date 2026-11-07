import { createContext, useContext } from "react"

/** Where GeoMap puts the phone's live vitals pill: the range chip's row, so the two share its width. */
export const MapLiveSlotContext = createContext<HTMLElement | null>(null)

export function useMapLiveSlot(): HTMLElement | null {
  return useContext(MapLiveSlotContext)
}
