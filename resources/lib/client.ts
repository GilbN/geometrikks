/**
 * Shared configuration for the generated @hey-api fetch client.
 * Mirrors the axios instance's 401 handling in lib/api.ts.
 */
import { client } from "@/generated/api/client.gen"

client.setConfig({ baseUrl: "" }) // same-origin; session cookie rides along

client.interceptors.response.use((response) => {
  if (
    response.status === 401 &&
    window.location.pathname !== "/login" &&
    !response.url.includes("/auth/login")
  ) {
    window.location.href = "/login"
  }
  return response
})
