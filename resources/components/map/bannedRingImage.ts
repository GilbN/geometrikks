/**
 * Dashed ring icons for packets from IPs under a decision.
 *
 * MapLibre circle layers cannot dash a stroke, so each cage is drawn once
 * into a canvas and registered as a map image for a symbol layer to place.
 */
import type { Map as MapLibreMap } from "maplibre-gl"
import { BANNED_RING_COLOR, CAPTCHA_RING_COLOR } from "@/lib/live-traffic/classify"

export const BANNED_RING_IMAGE_ID = "live-banned-ring"
export const CAPTCHA_RING_IMAGE_ID = "live-captcha-ring"

const SIZE = 64
const LINE_WIDTH = 6

function ensureRingImage(map: MapLibreMap, id: string, color: string): void {
  if (map.hasImage(id)) return

  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext("2d")
  if (!context) return

  context.strokeStyle = color
  context.lineWidth = LINE_WIDTH
  context.setLineDash([10, 8])
  context.beginPath()
  context.arc(SIZE / 2, SIZE / 2, SIZE / 2 - LINE_WIDTH, 0, Math.PI * 2)
  context.stroke()

  map.addImage(id, context.getImageData(0, 0, SIZE, SIZE), { pixelRatio: 2 })
}

export function ensureDecisionRingImages(map: MapLibreMap): void {
  ensureRingImage(map, BANNED_RING_IMAGE_ID, BANNED_RING_COLOR)
  ensureRingImage(map, CAPTCHA_RING_IMAGE_ID, CAPTCHA_RING_COLOR)
}
