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

test("the provider keeps a legacy accent's theme without saving it", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "green"), THEME_STORAGE_KEYS.legacyAccent)
  await page.goto("/static/resources/dev/themes.html")
  await expect(page.getByRole("heading", { name: "Theme component preview" })).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "moss")
  await expect(page.getByRole("button", { name: "Moss", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", themeColor("dark", "moss"))
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEYS.theme)).toBeNull()
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

type Scheme = { mode: "light" | "dark"; theme: ColorTheme }

async function openGallery(page: Page, { mode, theme }: Scheme) {
  await page.addInitScript(({ keys, mode, theme }) => {
    localStorage.setItem(keys.mode, mode)
    localStorage.setItem(keys.theme, theme)
  }, { keys: THEME_STORAGE_KEYS, mode, theme })
  await page.goto("/static/resources/dev/themes.html")
  await expect(page.getByRole("heading", { name: "Theme component preview" })).toBeVisible()
}

const tokensOf = (element: Locator) =>
  element.evaluate((el, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(el).getPropertyValue(name)])), [
    "--background",
    "--glass-card",
  ])

for (const { host, probe, own } of [
  { host: { mode: "dark", theme: "black" }, probe: "preview-light", own: { mode: "light", theme: "moss" } },
  { host: { mode: "light", theme: "aurora" }, probe: "preview-dark", own: { mode: "dark", theme: "forge" } },
] satisfies Array<{ host: Scheme; probe: string; own: Scheme }>) {
  test(`${probe} renders ${own.mode}/${own.theme} inside a ${host.mode}/${host.theme} page`, async ({ context, page }) => {
    // Expected values come from a page where that palette is the root, so a
    // rule leaking from the host page cannot shift expected and actual together.
    const isolated = await context.newPage()
    await openGallery(isolated, own)
    const expected = await tokensOf(isolated.locator("html"))
    await isolated.close()

    await openGallery(page, host)
    const hostTokens = await tokensOf(page.locator("html"))
    const previewTokens = await tokensOf(page.getByTestId(probe))
    for (const name of Object.keys(expected)) {
      expect(previewTokens[name], name).toBe(expected[name])
      expect(previewTokens[name], name).not.toBe(hostTokens[name])
    }
  })
}

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

test("settings page selects schemes and themes as radio groups", async ({ context, page }) => {
  const isolated = await context.newPage()
  await openGallery(isolated, { mode: "light", theme: "moss" })
  const lightMossBackground = (await tokensOf(isolated.locator("html")))["--background"].trim()
  await isolated.close()

  await openGallery(page, { mode: "dark", theme: "aurora" })
  const schemes = page.getByRole("radiogroup", { name: "Color scheme" })
  const themes = page.getByRole("radiogroup", { name: "Theme" })
  const schemeRadio = (name: string) => schemes.getByRole("radio", { name, exact: true })
  const themeRadio = (name: string) => themes.getByRole("radio", { name, exact: true })

  await expect(schemes.getByRole("radio")).toHaveCount(3)
  for (const name of ["System", "Light", "Dark"]) {
    await expect(schemeRadio(name)).toHaveAttribute("aria-checked", String(name === "Dark"))
  }
  await expect(themes.getByRole("radio")).toHaveCount(COLOR_THEMES.length)
  for (const id of COLOR_THEMES) {
    await expect(themeRadio(THEME_CATALOG[id].label)).toHaveAttribute("aria-checked", String(id === "aurora"))
  }

  const lightMossOrb = themeRadio("Moss").locator('.light[data-theme="moss"]')
  expect(await lightMossOrb.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(lightMossBackground)

  await themeRadio("Black").click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black")
  await expect(themeRadio("Black")).toHaveAttribute("aria-checked", "true")
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEYS.theme)).toBe("black")

  await schemeRadio("Light").click()
  await expect(page.locator("html")).toHaveClass("light")
  await expect(schemeRadio("Light")).toHaveAttribute("aria-checked", "true")
  await expect(themeRadio("Black")).toHaveAttribute("aria-checked", "true")

  await themeRadio("Black").focus()
  // Radix checks a radio only if the arrow key is still down when focus lands,
  // and it moves focus in a timeout, so a press that releases at once never selects.
  await page.keyboard.down("ArrowLeft")
  try {
    await expect(themeRadio("Forge")).toHaveAttribute("aria-checked", "true")
    await expect(themeRadio("Forge")).toBeFocused()
  } finally {
    await page.keyboard.up("ArrowLeft")
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forge")
  const outline = await themeRadio("Forge").evaluate((el) => {
    const style = getComputedStyle(el)
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }
  })
  expect(outline.style).not.toBe("none")
  expect(outline.width).toBeGreaterThan(0)


  await page.setViewportSize({ width: 390, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  for (const id of COLOR_THEMES) {
    const card = themeRadio(THEME_CATALOG[id].label)
    await card.scrollIntoViewIfNeeded()
    await expect(card).toBeInViewport()
  }
})
