import { expect, test, type Locator, type Page } from "@playwright/test"
import { COLOR_THEMES, THEME_CATALOG, THEME_STORAGE_KEYS, themeColor, type ColorTheme } from "../../resources/lib/theme"

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

const palettes: { mode: "light" | "dark"; theme: ColorTheme }[] = COLOR_THEMES.flatMap((theme) => [
  { mode: "light" as const, theme },
  { mode: "dark" as const, theme },
])

async function expectBodyMatchesChrome(page: Page) {
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
}

for (const { mode, theme } of palettes) {
  test(`${mode}/${theme} paints the palette before React loads`, async ({ page }) => {
    await page.addInitScript(({ keys, mode, theme }) => {
      localStorage.setItem(keys.mode, mode)
      localStorage.setItem(keys.theme, theme)
    }, { keys: THEME_STORAGE_KEYS, mode, theme })
    await page.route("**/resources/dev/themes.tsx*", (route) => route.abort())
    await page.goto("/static/resources/dev/themes.html")
    await expect(page.locator("html")).toHaveClass(mode)
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", themeColor(mode, theme))
    await expectBodyMatchesChrome(page)
    await expect(page.locator("#app")).toBeEmpty()
  })
}

test("a saved legacy accent paints its theme before React loads", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "green"), THEME_STORAGE_KEYS.legacyAccent)
  await page.route("**/resources/dev/themes.tsx*", (route) => route.abort())
  await page.goto("/static/resources/dev/themes.html")
  await expect(page.locator("html")).toHaveClass("dark")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "moss")
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", themeColor("dark", "moss"))
  await expectBodyMatchesChrome(page)
  await expect(page.locator("#app")).toBeEmpty()
})

for (const width of [1280, 390]) {
  for (const { mode, theme } of palettes) {
    test(`${mode}/${theme} controls stay visible at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.addInitScript(({ keys, mode, theme }) => {
        localStorage.setItem(keys.mode, mode)
        localStorage.setItem(keys.theme, theme)
      }, { keys: THEME_STORAGE_KEYS, mode, theme })
      await page.goto("/static/resources/dev/themes.html")
      await expect(page.getByRole("heading", { name: "Theme component preview" })).toBeVisible()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", themeColor(mode, theme))

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
      expect(contrast(handle, colors.background)).toBeGreaterThan(mode === "dark" && theme === "black" ? 3 : 1.04)
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

      const rootToken = (name: string) =>
        page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name), name)
      const chartColor = await rootToken("--chart-1")
      const primaryColors = new Set<string>()
      for (const id of COLOR_THEMES) {
        await page.getByRole("button", { name: THEME_CATALOG[id].label, exact: true }).click()
        await expect(page.locator("html")).toHaveAttribute("data-theme", id)
        primaryColors.add(await rootToken("--primary"))
        expect(await rootToken("--chart-1")).toBe(chartColor)
      }
      expect(primaryColors.size).toBe(COLOR_THEMES.length)
    })
  }
}

test("scoped previews render their own palette inside any page", async ({ page }) => {
  await page.addInitScript(({ keys }) => {
    localStorage.setItem(keys.mode, "dark")
    localStorage.setItem(keys.theme, "black")
  }, { keys: THEME_STORAGE_KEYS })
  await page.goto("/static/resources/dev/themes.html")
  await expect(page.getByTestId("preview-light")).toBeVisible()
  const tokens = await page.evaluate(() => {
    const read = (element: Element, name: string) => getComputedStyle(element).getPropertyValue(name)
    const expected = (className: string, theme: string, name: string) => {
      const probe = document.createElement("div")
      probe.className = className
      probe.dataset.theme = theme
      document.body.append(probe)
      const value = read(probe, name)
      probe.remove()
      return value
    }
    const light = document.querySelector('[data-testid="preview-light"]')!
    const dark = document.querySelector('[data-testid="preview-dark"]')!
    return {
      page: { background: read(document.documentElement, "--background"), glass: read(document.documentElement, "--glass-card") },
      light: { background: read(light, "--background"), glass: read(light, "--glass-card") },
      dark: { background: read(dark, "--background") },
      expected: {
        lightBackground: expected("light", "moss", "--background"),
        lightGlass: expected("light", "moss", "--glass-card"),
        darkBackground: expected("dark", "forge", "--background"),
      },
    }
  })
  expect(tokens.expected.lightBackground).not.toBe(tokens.page.background)
  expect(tokens.expected.darkBackground).not.toBe(tokens.page.background)
  expect(tokens.light.background).toBe(tokens.expected.lightBackground)
  expect(tokens.light.glass).toBe(tokens.expected.lightGlass)
  expect(tokens.light.glass).not.toBe(tokens.page.glass)
  expect(tokens.dark.background).toBe(tokens.expected.darkBackground)
})

test("System switches palettes live and retains the saved theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/static/resources/dev/themes.html")
  await page.getByRole("button", { name: "Black", exact: true }).click()
  await page.getByRole("button", { name: "System", exact: true }).click()
  await expect(page.locator("html")).toHaveClass("dark")
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveClass("light")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass("dark")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black")
  await page.reload()
  await expect(page.locator("html")).toHaveClass("dark")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black")
})

test("theme menu only switches color mode", async ({ page }) => {
  await page.goto("/static/resources/dev/themes.html")
  for (const mode of ["Light", "Dark", "System"]) {
    await page.getByRole("button", { name: "Toggle theme", exact: true }).click()
    await page.getByRole("menuitemradio", { name: mode, exact: true }).click()
    await page.getByRole("button", { name: "Toggle theme", exact: true }).click()
    await expect(page.getByRole("menuitemradio")).toHaveCount(3)
    for (const label of ["Light", "Dark", "System"]) {
      await expect(page.getByRole("menuitemradio", { name: label, exact: true })).toHaveAttribute("aria-checked", String(label === mode))
    }
    for (const label of ["Black", "Aurora"]) {
      await expect(page.getByRole("menuitemradio", { name: label, exact: true })).toHaveCount(0)
    }
    await page.keyboard.press("Escape")
  }
})
