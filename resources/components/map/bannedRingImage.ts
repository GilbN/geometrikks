/**
 * A dashed ring icon for banned-IP packets.
 *
 * MapLibre circle layers cannot dash a stroke, so the cage is drawn once into
 * a canvas and registered as a map image for a symbol layer to place.
 */
import type { Map as MapLibreMap } from "maplibre-gl"
import { BANNED_RING_COLOR } from "@/lib/live-traffic/classify"

export const BANNED_RING_IMAGE_ID = "live-banned-ring"

const SIZE = 64
const LINE_WIDTH = 6

export function ensureBannedRingImage(map: MapLibreMap): void {
  if (map.hasImage(BANNED_RING_IMAGE_ID)) return

  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext("2d")
  if (!context) return

  context.strokeStyle = BANNED_RING_COLOR
  context.lineWidth = LINE_WIDTH
  context.setLineDash([10, 8])
  context.beginPath()
  context.arc(SIZE / 2, SIZE / 2, SIZE / 2 - LINE_WIDTH, 0, Math.PI * 2)
  context.stroke()

  const image = context.getImageData(0, 0, SIZE, SIZE)
  map.addImage(BANNED_RING_IMAGE_ID, image, { pixelRatio: 2 })
}
