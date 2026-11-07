import { toast } from "sonner"
import { logout } from "@/lib/api"
import { logoutThenNavigate } from "@/lib/auth-redirect"
import { flushIpActions } from "@/lib/pending-ip-actions"

export async function logOut(): Promise<void> {
  try {
    // A ban or unban still in its undo window goes out while the session lives.
    await flushIpActions()
    // Hard navigation is deliberate, not a leftover: it discards the
    // TanStack Query cache holding the previous session's data, which a
    // client-side redirect would not. The /logout route does the same.
    await logoutThenNavigate(logout, (url) => {
      window.location.href = url
    })
  } catch {
    toast.error("Logout failed. Try again.")
  }
}
