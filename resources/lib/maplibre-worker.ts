/**
 * MapLibre 6 runs tile and GeoJSON processing in a separate worker script and
 * looks for it next to its own module URL. Inside a Vite bundle that file is
 * never emitted, so every GL layer (tiles, heatmap, live routes) stays blank
 * while DOM markers keep working. This is the copy Vite bundles instead.
 */
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"

export const MAPLIBRE_WORKER_URL = workerUrl
