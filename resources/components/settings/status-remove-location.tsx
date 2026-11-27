import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/** Confirms removing a retired server's auto-detected location. */
export function RemoveLocationAlert({
  server,
  open,
  onOpenChange,
  pending,
  onRemove,
}: {
  server: string
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onRemove: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the location for {server}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its beacon leaves the map and live routes stop flying to it. If an agent still ingests
            as {server}, the location comes back at that agent's next refresh.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={onRemove}>
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
