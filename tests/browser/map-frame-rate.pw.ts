import { expect, test } from "@playwright/test"

for (const width of [1280, 390]) {
  test(`frame rate menu persists and removes its counter at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 })
    const password =
      process.env.SMOKE_ADMIN_PASSWORD ?? process.env.APP_ADMIN_PASSWORD
    if (!password) throw new Error("Administrator credentials are required")
    const response = await page.request.post("/api/v1/auth/login", {
      data: {
        username:
          process.env.SMOKE_ADMIN_USER ?? process.env.APP_ADMIN_USER ?? "admin",
        password,
      },
    })
    expect(response.ok()).toBe(true)
    await page.addInitScript(() =>
      localStorage.setItem("geometrikks-map-live", "false"),
    )
    await page.goto("/map")
    const monitor = page.getByTestId("map-frame-rate")
    const toolsMenu = page.getByRole("button", {
      name: "Map tools",
      exact: true,
    })
    const openMenu = async () => {
      if (width < 768 && !(await page.locator('[data-slot="drawer-content"]').isVisible())) {
        await page
          .getByRole("button", { name: "Map Controls", exact: true })
          .click()
      }
      await toolsMenu.click()
    }
    const toggle = page.getByRole("menuitemcheckbox", {
      name: "Show frame rate",
      exact: true,
    })
    await openMenu()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await expect(monitor).toHaveCount(0)
    await toggle.click()
    if (width < 768) {
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-slot="drawer-content"]')).toBeHidden()
    }
    await expect(monitor).toHaveCSS("pointer-events", "none")
    // Let initial tile/style rendering settle before deliberately moving the map.
    await page.waitForTimeout(2000)
    await expect(monitor).toHaveText("0.0 FPS", { timeout: 20_000 })
    const bounds = await monitor.boundingBox()
    if (!bounds) throw new Error("Frame rate counter is not visible")
    const x = bounds.x + bounds.width / 2
    const y = bounds.y + bounds.height / 2
    // Start on the badge to also exercise dragging through the overlay. Keep
    // moving across sampling windows so a missing FPS listener cannot pass.
    await page.mouse.move(x, y)
    await page.mouse.down()
    let direction = 1
    try {
      await expect
        .poll(async () => {
          await page.mouse.move(x + direction * 40, y - 20, { steps: 5 })
          direction *= -1
          return Number.parseFloat((await monitor.textContent()) ?? "")
        }, { intervals: [100], timeout: 10_000 })
        .toBeGreaterThan(0)
    } finally {
      await page.mouse.up()
    }
    await expect(monitor).toHaveText("0.0 FPS", { timeout: 20_000 })
    await page.reload()
    await openMenu()
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await expect(monitor).toHaveCount(1)
    await expect(monitor).toHaveText("0.0 FPS", { timeout: 20_000 })
    await toggle.click()
    await expect(monitor).toHaveCount(0)
    await openMenu()
    await toggle.click()
    await expect(monitor).toHaveCount(1)
    await openMenu()
    await toggle.click()
    await page.reload()
    await openMenu()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await expect(monitor).toHaveCount(0)
  })
}
