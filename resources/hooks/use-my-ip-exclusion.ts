/**
 * One-tap exclusion of the viewer's own IP on the log pages. The address
 * comes from the server, because a browser cannot see its public address.
 * Each tap adds to the page's excluded IPs, so the addresses a phone picks
 * up on different networks pile up until the page is opened fresh.
 */
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { myIpExclusion, toggleWithFreshIp, type MyIpExclusion } from "@/lib/my-ip-exclusion"
import { fetchFreshClientIp, useClientIp } from "@/lib/queries"

export function useMyIpExclusion(
  excludedIps: string[],
  onAdd: (ip: string) => void,
  onRemove: (ip: string) => void,
): MyIpExclusion {
  const { data } = useClientIp()
  const queryClient = useQueryClient()
  const tapping = useRef(false)
  const mounted = useRef(true)
  const latest = useRef({ excludedIps, onAdd, onRemove })
  useEffect(() => {
    latest.current = { excludedIps, onAdd, onRemove }
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return {
    ...myIpExclusion(data, excludedIps, onAdd, onRemove),
    toggle: () => {
      if (tapping.current) return
      tapping.current = true
      void toggleWithFreshIp(
        () => fetchFreshClientIp(queryClient),
        () => mounted.current,
        () => latest.current.excludedIps,
        (ip) => latest.current.onAdd(ip),
        (ip) => latest.current.onRemove(ip),
      ).finally(() => {
        tapping.current = false
      })
    },
  }
}
