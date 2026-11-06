import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

// A nested copy keeps its own focus-trap and layer stacks, so a drawer opened
// over a dialog or sheet can't take focus and leaves the page unclickable.
it("vaul resolves to the app's Radix Dialog, not a nested copy", () => {
  const lock = readFileSync(new URL("../../bun.lock", import.meta.url), "utf8")
  expect(
    lock,
    'bun nested a Radix Dialog copy under vaul. Delete every "vaul/@radix-ui/" entry from bun.lock, then run bun install.',
  ).not.toMatch(/"vaul\/@radix-ui\//)
})
