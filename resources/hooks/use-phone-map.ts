/** A phone held sideways: a short touch screen at least 4:3 wide. The aspect
 *  ratio, not `orientation`, keeps out a portrait phone whose keyboard
 *  squashes the viewport to about square. */
export const PHONE_SIDE_QUERY = "(pointer: coarse) and (min-aspect-ratio: 4/3) and (height < 30rem)"

/** Reads the side query synchronously, for one-shot decisions outside render. */
export function isPhoneSideViewport(): boolean {
  return window.matchMedia(PHONE_SIDE_QUERY).matches
}
