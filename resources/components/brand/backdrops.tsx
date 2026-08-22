/**
 * Full-bleed backdrops for BrandScreen, the same two pictures as the README
 * banners: routes converging on the mark, and relief contours. Both read
 * their colors from the theme tokens, so they follow the accent and the
 * color mode. Deterministic: no Math.random, every load draws the same scene.
 */
import { useEffect, useRef } from "react"

const W = 1280
const H = 800

// Where the lockup sits in the 1280x800 reference frame.
const HOME: [number, number] = [640, 300]

const ORIGINS: Array<[number, number]> = [
  [0, 80], [0, 560], [160, 0], [380, 800], [1280, 40], [1280, 420],
  [1040, 800], [820, 0], [1220, 760], [520, 0], [0, 330], [1280, 640],
]

/** Arcs from the frame's edges converging on the mark, one lit packet each. */
export function RoutesBackdrop() {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full text-primary"
    >
      <circle cx={HOME[0]} cy={HOME[1]} r={220} fill="currentColor" opacity={0.1} style={{ filter: "blur(60px)" }} />
      {ORIGINS.map(([x, y], i) => {
        const cx = (x + HOME[0]) / 2 + (i % 2 ? 1 : -1) * 120
        const cy = (y + HOME[1]) / 2 + (x < HOME[0] ? -90 : 90)
        const u = 0.35 + ((i * 0.13) % 0.5)
        const px = (1 - u) ** 2 * x + 2 * (1 - u) * u * cx + u * u * HOME[0]
        const py = (1 - u) ** 2 * y + 2 * (1 - u) * u * cy + u * u * HOME[1]
        const strong = i % 3 === 0
        return (
          <g key={i} stroke="currentColor" fill="none">
            <path d={`M${x} ${y} Q${cx} ${cy} ${HOME[0]} ${HOME[1]}`} strokeWidth={strong ? 1.5 : 1} opacity={strong ? 0.45 : 0.18} />
            <circle cx={px} cy={py} r={3.2} fill="currentColor" stroke="none" opacity={0.9} style={{ filter: "drop-shadow(0 0 6px currentColor)" }} />
          </g>
        )
      })}
    </svg>
  )
}

const seed = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * (t * t * (3 - 2 * t))
const noise = (x: number, y: number) => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
  return lerp(lerp(seed(xi, yi), seed(xi + 1, yi), xf), lerp(seed(xi, yi + 1), seed(xi + 1, yi + 1), xf), yf)
}

// Marching-squares edge table: which cell edges each corner pattern joins.
const SEGMENTS: Record<number, string> = {
  1: "lb", 2: "br", 3: "lr", 4: "tr", 5: "tl,br", 6: "tb", 7: "tl", 8: "tl",
  9: "tb", 10: "tr,lb", 11: "tr", 12: "lr", 13: "br", 14: "lb",
}

// The canvas renders at most this wide and scales up through CSS; contour
// lines at 1px stay crisp enough and the cost stops growing with the window.
const MAX_W = 1280

function drawRelief(canvas: HTMLCanvasElement, accent: string, line: string) {
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  const scale = Math.min(1, MAX_W / Math.max(1, canvas.clientWidth))
  const w = (canvas.width = Math.round(canvas.clientWidth * scale))
  const h = (canvas.height = Math.round(canvas.clientHeight * scale))
  ctx.clearRect(0, 0, w, h)

  // Sample the field once on the grid; every level then reads the cache
  // instead of re-evaluating three octaves of noise per corner.
  const step = 8
  const cols = Math.ceil(w / step) + 1
  const rows = Math.ceil(h / step) + 1
  const grid = new Float32Array(cols * rows)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * step, y = j * step
      grid[j * cols + i] =
        noise(x / 260, y / 260) * 0.6 +
        noise(x / 90, y / 90) * 0.3 +
        noise(x / 30, y / 30) * 0.1 +
        // Flatten a plateau under the lockup so the card sits on calm ground.
        0.35 * Math.exp(-(((x - w / 2) / 320) ** 2 + ((y - h / 2) / 300) ** 2))
    }
  }

  const levels = 14
  const mid = step / 2
  for (let l = 1; l < levels; l++) {
    const iso = l / levels
    const accented = l % 4 === 0
    ctx.strokeStyle = accented ? accent : line
    ctx.globalAlpha = accented ? 0.3 : 0.18
    ctx.lineWidth = accented ? 1.2 : 0.8
    ctx.beginPath()
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const idx =
          (grid[j * cols + i] > iso ? 8 : 0) +
          (grid[j * cols + i + 1] > iso ? 4 : 0) +
          (grid[(j + 1) * cols + i + 1] > iso ? 2 : 0) +
          (grid[(j + 1) * cols + i] > iso ? 1 : 0)
        if (idx === 0 || idx === 15) continue
        const x = i * step, y = j * step
        const pts: Record<string, [number, number]> = {
          t: [x + mid, y], r: [x + step, y + mid], b: [x + mid, y + step], l: [x, y + mid],
        }
        for (const seg of SEGMENTS[idx].split(",")) {
          const p0 = pts[seg[0]], p1 = pts[seg[1]]
          ctx.moveTo(p0[0], p0[1])
          ctx.lineTo(p1[0], p1[1])
        }
      }
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Contour lines from a noise field, redrawn on resize and theme change. */
export function ReliefBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    // Canvas cannot read CSS variables, so resolve the two colors through
    // computed styles on the canvas itself (color) and its parent (border).
    // Coalesce bursts (a drag-resize fires per frame) into one draw.
    let frame = 0
    const draw = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const style = getComputedStyle(canvas)
        drawRelief(canvas, style.color, style.borderColor)
      })
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    const mo = new MutationObserver(draw)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-accent"] })
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full border-0 border-muted-foreground text-primary"
    />
  )
}
