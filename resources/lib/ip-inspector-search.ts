/** Root-level `?inspect=<ip>` codec. Pure module: vitest runs without a
 *  DOM, so no router imports here. Validity of the value as an IP is the
 *  sheet's problem, not the URL's. */
import { z } from "zod"

export const inspectSearchSchema = z.object({
  inspect: z.string().optional().catch(undefined),
})

export type InspectSearch = z.infer<typeof inspectSearchSchema>
