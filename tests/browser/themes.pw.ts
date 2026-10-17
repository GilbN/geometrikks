import { expect, test, type Locator } from "@playwright/test"
import { ACCENTS } from "../../resources/lib/accent"
import { DARK_APPEARANCES, THEME_STORAGE_KEYS, themeColor, type DarkAppearance } from "../../resources/lib/theme"

type RGBA = [number, number, number, number]

function composite(fg: RGBA, bg: RGBA): RGBA {
  return [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as RGBA
}

function contrast(a: RGBA, b: RGBA): number {
  const luminance = (rgba: RGBA) => rgba.slice(0, 3).reduce((sum, value, i) => {
    const v = value / 255
    return sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
  }, 0)
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

async function panelColors(panel: Locator) {
  return panel.evaluate((element) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    const color = (css: string): RGBA => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data)
      return [pixel[0], pixel[1], pixel[2], pixel[3] / 255]
    }
    const style = (selector: string) => getComputedStyle(element.querySelector(selector)!)
    const badge = style('[data-slot="badge"][data-variant="secondary"]')
    const handle = element.querySelector('[data-slot="drawer-handle"]')
    return {
      background: color(getComputedStyle(element).backgroundColor),
      tabs: color(style('[data-slot="tabs-list"]').backgroundColor),
      badge: color(badge.backgroundColor),
      badgeText: color(badge.color),
      handle: handle ? color(getComputedStyle(handle).backgroundColor) : null,
    }
  })
}

const palettes: { mode: "light" | "dark"; appearance: DarkAppearance }[] = [
  { mode: "light", appearance: "aurora" },
  ...DARK_APPEARANCES.map((appearance) => ({ mode: "dark" as const, appearance })),
]

for (const { mode, appearance } of palettes) {
  test(`${mode}/${appearance} paints the palette before React loads`, async ({ page }) => {
    await page.addInitScript(({ keys, mode, appearance }) => {
      localStorage.setItem(keys.mode, mode)
      localStorage.setItem(keys.appearance, appearance)
    }, { keys: THEME_STORAGE_KEYS, mode, appearance })
    await page.route("**/resources/dev/themes.tsx*", (route) => route.abort())
    await page.goto("/static/resources/dev/themes.html")
    await expect(page.locator("html")).toHaveClass(mode)
    await expect(page.locator("html")).toHaveAttribute("data-dark-appearance", appearance)
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", themeColor(mode, appearance))
    const colors = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext("2d")!
      const rgb = (color: string) => {
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
      }
      return { body: rgb(getComputedStyle(document.body).backgroundColor), chrome: rgb(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content) }
    })
    colors.body.forEach((channel, i) => expect(Math.abs(channel - colors.chrome[i])).toBeLessThanOrEqual(2))
    await expect(page.locator("#app")).toBeEmpty()
  })
}

for (const width of [1280, 390]) {
  for (const { mode, appearance } of palettes) {
    test(`${mode}/${appearance} controls stay visible at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.addInitScript(({ keys, mode, appearance }) => {
        localStorage.setItem(keys.mode, mode)
        localStorage.setItem(keys.appearance, appearance)
        localStorage.setItem(keys.accent, "teal")
      }, { keys: THEME_STORAGE_KEYS, mode, appearance })
      await page.goto("/static/resources/dev/themes.html")
      await expect(page.getByRole("heading", { name: "Theme component preview" })).toBeVisible()
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", themeColor(mode, appearance))

      const mapPanel = page.getByRole("complementary", { name: "Preview map panel" })
      expect((await panelColors(mapPanel)).background[3]).toBeCloseTo(0.85, 1)
      expect(await mapPanel.evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe("none")
      const floatingFill = await page.evaluate(() => {
        const probe = document.createElement("div")
        probe.className = "bg-floating"
        document.body.append(probe)
        const fill = getComputedStyle(probe).backgroundColor
        probe.remove()
        return fill
      })
      expect(await mapPanel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(floatingFill)

      const card = page.getByTestId("card")
      const initialCard = await panelColors(card)
      const chartColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chart-1"))
      const primaryColors = new Set<string>()
      for (const accent of ACCENTS) {
        await page.getByRole("button", { name: accent, exact: true }).click()
        await expect(page.locator("html")).toHaveAttribute("data-dark-appearance", appearance)
        primaryColors.add(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary")))
        expect((await panelColors(card)).background).toEqual(initialCard.background)
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chart-1"))).toBe(chartColor)
      }
      expect(primaryColors.size).toBe(ACCENTS.length)

      const heatmap = card.getByRole("tab", { name: "Heatmap" })
      const inactiveColor = await heatmap.evaluate((el) => getComputedStyle(el).color)
      await heatmap.hover()
      await expect.poll(() => heatmap.evaluate((el) => getComputedStyle(el).color)).not.toBe(inactiveColor)
      await heatmap.click()
      await expect(heatmap).toHaveAttribute("aria-selected", "true")
      const input = card.getByRole("textbox")
      const unfocusedShadow = await input.evaluate((el) => getComputedStyle(el).boxShadow)
      await input.focus()
      await expect.poll(() => input.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe(unfocusedShadow)
      const select = card.getByRole("combobox")
      const restingBackground = await select.evaluate((el) => getComputedStyle(el).backgroundColor)
      await select.hover()
      if (mode === "dark") await expect.poll(() => select.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(restingBackground)
      await select.click()
      await page.getByRole("option", { name: "Norway" }).click()
      await expect(select).toContainText("Norway")

      await page.getByRole("button", { name: "Open drawer", exact: true }).click()
      const drawer = page.locator('[data-slot="drawer-content"]')
      await expect(drawer).toBeVisible()
      await expect(drawer.locator('[data-slot="drawer-handle"]')).toBeVisible()
      const colors = await panelColors(drawer)
      expect(colors.background[3]).toBe(1)
      // Catch fills collapsing into the containing panel, the original Black regression.
      expect(contrast(colors.tabs, colors.background)).toBeGreaterThan(mode === "light" ? 1.04 : 1.1)
      expect(contrast(colors.badge, colors.background)).toBeGreaterThan(mode === "light" ? 1.04 : 1.1)
      expect(contrast(colors.badgeText, colors.badge)).toBeGreaterThan(4.5)
      const handle = composite(colors.handle!, colors.background)
      expect(contrast(handle, colors.background)).toBeGreaterThan(mode === "dark" && appearance === "black" ? 3 : 1.04)
      await page.screenshot({ path: testInfo.outputPath("drawer.png") })
      await page.keyboard.press("Escape")
      await expect(drawer).not.toBeVisible()

      await page.getByRole("button", { name: "Open dialog", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Preview dialog" })
      await expect(dialog).toBeVisible()
      const dialogColors = await panelColors(dialog)
      expect(contrast(dialogColors.badgeText, dialogColors.badge)).toBeGreaterThan(4.5)
      await page.keyboard.press("Escape")
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    })
  }
}

test("System switches palettes live and retains the saved dark appearance", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/static/resources/dev/themes.html")
  await page.getByRole("button", { name: "Black", exact: true }).click()
  await page.getByRole("button", { name: "System", exact: true }).click()
  await expect(page.locator("html")).toHaveClass("dark")
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveClass("light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass("dark")
  await expect(page.locator("html")).toHaveAttribute("data-dark-appearance", "black")
  await page.reload()
  await expect(page.locator("html")).toHaveClass("dark")
  await expect(page.locator("html")).toHaveAttribute("data-dark-appearance", "black")
})

test("theme menu exposes the selected mode and appearance independently", async ({ page }) => {
  await page.goto("/static/resources/dev/themes.html")
  await page.getByRole("button", { name: "Black", exact: true }).click()
  for (const mode of ["Light", "Dark", "System"]) {
    await page.getByRole("button", { name: "Toggle theme", exact: true }).click()
    await page.getByRole("menuitemradio", { name: mode, exact: true }).click()
    await page.getByRole("button", { name: "Toggle theme", exact: true }).click()
    for (const label of ["Light", "Dark", "System"]) {
      await expect(page.getByRole("menuitemradio", { name: label, exact: true })).toHaveAttribute("aria-checked", String(label === mode))
    }
    await expect(page.getByRole("menuitemradio", { name: "Black", exact: true })).toHaveAttribute("aria-checked", "true")
    await expect(page.getByRole("menuitemradio", { name: "Aurora", exact: true })).toHaveAttribute("aria-checked", "false")
    await page.keyboard.press("Escape")
  }
})
