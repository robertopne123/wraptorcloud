// Read-only smoke check against a running vault with media in its first folder.
(async () => {
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    for (const mobile of [true, false]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const activate = (locator) => mobile ? locator.tap() : locator.click();
      await page.goto(process.env.VAULT_TEST_URL || "http://localhost:3000/vault", { waitUntil: "networkidle" });
      const folder = page.getByRole("button", { name: /^Open / }).first();
      await expect(folder).toBeVisible();
      const tile = folder.locator("..");
      const checkbox = tile.getByRole("checkbox");
      await activate(checkbox);
      await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
      await activate(checkbox);
      await activate(tile.getByRole("button", { name: "Item actions", exact: true }));
      await expect(tile.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
      await activate(tile.getByRole("button", { name: "Rename", exact: true }));
      await expect(page.getByRole("heading", { name: "Rename folder", exact: true })).toBeVisible();
      await activate(page.getByRole("button", { name: "Cancel", exact: true }));
      await activate(folder.locator("svg").first());
      await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeVisible();
      await expect(page.getByText("Loading folder…", { exact: true })).toHaveCount(0);
      await activate(page.getByRole("button", { name: "Root", exact: true }));
      await expect(page.getByRole("button", { name: "Go back", exact: true })).toHaveCount(0);
      await activate(page.getByRole("button", { name: /^Open / }).first().locator("..").locator("span.text-center").first());
      await expect(page.getByRole("button", { name: "Go back", exact: true })).toBeVisible();
      await expect(page.getByText("Loading folder…", { exact: true })).toHaveCount(0);
      await activate(page.getByRole("button", { name: /^Open / }).first());
      await expect(page.locator(".yarl__root")).toBeVisible();
      await activate(page.getByRole("button", { name: "Close", exact: true }));
      await expect(page.locator(".yarl__root")).toHaveCount(0);
      await expect(page.locator("[draggable=true]")).toHaveCount(0);
      expect(errors).toEqual([]);
      console.log(`${mobile ? "Mobile tap" : "Desktop click"}: checkbox, menu, rename, icon, item count, navigation and file viewer passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
