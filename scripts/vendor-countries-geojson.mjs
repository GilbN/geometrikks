// Vendors Natural Earth 110m admin-0 into resources/static/countries.geojson:
// geometry + { id: ISO alpha-2, name }. Run manually (bun
// scripts/vendor-countries-geojson.mjs) and commit the output; the vitest in
// resources/lib/countries-geojson.test.ts re-asserts the invariants offline.
import { writeFileSync } from "node:fs"

const SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"

// ISO_A2 is -99 for sovereign-state map units (France, Norway) and for
// territories without an assigned code. ISO_A2_EH fixes the former; this map
// settles the rest. GeoLite2 emits XK for Kosovo. Entries mapping to null are
// dropped: GeoLite2 never emits a code for them, so they could only ever
// render as no-data.
const ADM0_A3_FIXUPS = { KOS: "XK", CYN: null, SOL: null, KAS: null }

const raw = await (await fetch(SOURCE)).json()

const features = []
const dropped = []
for (const feature of raw.features) {
  const p = feature.properties
  let id = p.ISO_A2_EH
  if (!/^[A-Z]{2}$/.test(id)) {
    const fixed = ADM0_A3_FIXUPS[p.ADM0_A3]
    if (fixed === undefined) {
      throw new Error(`Unmapped feature without ISO code: ${p.NAME} (${p.ADM0_A3})`)
    }
    if (fixed === null) {
      dropped.push(p.NAME)
      continue
    }
    id = fixed
  }
  features.push({
    type: "Feature",
    geometry: feature.geometry,
    properties: { id, name: p.NAME },
  })
}

const ids = features.map((f) => f.properties.id)
if (new Set(ids).size !== ids.length) {
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  throw new Error(`Duplicate ids: ${[...new Set(dupes)].join(", ")}`)
}

writeFileSync(
  new URL("../resources/static/countries.geojson", import.meta.url),
  JSON.stringify({ type: "FeatureCollection", features }),
)
console.log(`wrote ${features.length} countries; dropped: ${dropped.join(", ") || "none"}`)
