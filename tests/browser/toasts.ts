import type { Locator } from "@playwright/test"

/** Where a Sonner toast comes to rest. Sonner holds a new toast off screen until
 *  it sets data-mounted, then slides it in, so two equal polls from the test can
 *  both land before the slide. The page waits for data-mounted, gives the
 *  transition a frame to start, then waits for its animations to finish. */
export async function settledToastBox(toast: Locator) {
  return toast.evaluate(async (element) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    while (element.getAttribute("data-mounted") !== "true") await frame()
    await frame()
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
    const { x, y, width, height } = element.getBoundingClientRect()
    return { x, y, width, height }
  })
}
