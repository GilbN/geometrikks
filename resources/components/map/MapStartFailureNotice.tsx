import { ErrorBanner } from "@/components/error-banner"
import type { MapStartFailure } from "@/lib/map-start-failure"

/** Centered over the empty map container, so the page around it stays usable. */
export function MapStartFailureNotice({ failure }: { failure: MapStartFailure }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
      <ErrorBanner
        className="pointer-events-auto w-full max-w-md backdrop-blur-[2px]"
        title={failure.title}
        detail={failure.detail}
      />
    </div>
  )
}
