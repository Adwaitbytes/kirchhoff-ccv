import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * PRD 17.DOD3: every figure is one click from its source. A figure is any element marked
 * data-figure; it must sit inside a link with an href, or be explicitly marked not public, and
 * either way carry a description of its source.
 */
async function expectEverySourced(scope: Locator, minimum: number): Promise<void> {
  const figures = scope.locator("[data-figure]");
  const n = await figures.count();
  expect(n, "figures found").toBeGreaterThanOrEqual(minimum);
  const results = await figures.evaluateAll((els) =>
    els.map((el) => {
      const link = el.closest("a[href]");
      const href = link?.getAttribute("href") ?? "";
      const source = el.getAttribute("data-source") ?? link?.getAttribute("aria-label") ?? "";
      return { text: (el.textContent ?? "").trim(), href, notPublic: el.hasAttribute("data-not-public"), source };
    }),
  );
  for (const [i, r] of results.entries()) {
    const linked = /^(https:\/\/|\/)/.test(r.href);
    expect(linked || r.notPublic, `figure ${i} "${r.text}" has no source link`).toBe(true);
    expect(r.source.length, `figure ${i} "${r.text}" has no source description`).toBeGreaterThan(8);
  }
}

async function openMission(page: Page, scenario?: string): Promise<void> {
  await page.goto(`/app/tokens/kETH${scenario ? `?scenario=${scenario}` : ""}`);
  await expect(page.getByTestId("status-pill")).toBeVisible();
  await expect(page.getByTestId("verdict-row").first()).toBeVisible();
}

test.describe("every number links to its source", () => {
  test("Mission Control: top bar, circuit, meter, verdicts, ledger and Δ history", async ({ page }) => {
    await openMission(page);
    const main = page.locator("body");
    // Spot checks on the figures PRD section 12 names, then the sweep over all of them.
    await expect(page.getByTestId("delta-readout").locator("xpath=ancestor::a[1]")).toHaveAttribute("href", /#readContract$/);
    await expect(page.getByRole("link", { name: /Arbitrum Sepolia supply .* token totalSupply/ })).toHaveAttribute("href", /\/token\/0x/);
    await expect(page.getByRole("link", { name: /^Backing .*escrow balance on the explorer/ }).first()).toHaveAttribute("href", /\/token\/0x.*\?a=0x/);
    await expect(page.getByRole("link", { name: /Pinned block \d+ on Base Sepolia/ }).first()).toHaveAttribute("href", /\/block\/\d+$/);
    await expect(page.getByRole("link", { name: /source debit transaction/ }).first()).toHaveAttribute("href", /\/tx\/0x/);
    await expectEverySourced(main, 25);

    await page.getByRole("group", { name: "Δ history view" }).getByRole("button", { name: "Table" }).click();
    await expect(page.getByRole("link", { name: /at epoch \d+, epoch report transaction/ }).first()).toHaveAttribute("href", /\/tx\/0x/);
    await expectEverySourced(main, 60);

    await page.getByRole("button", { name: /Base Sepolia: .* Open ledger/ }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expectEverySourced(drawer, 5);
  });

  test("Incident Room: Δ before and after, amounts, block ranges, timings", async ({ page }) => {
    await openMission(page, "breach");
    await expectEverySourced(page.locator("body"), 25);
    await page.getByRole("link", { name: "Open Incident Room" }).first().click();
    await expect(page.getByTestId("incident-header")).toBeVisible();
    await expect(page.getByRole("link", { name: /^Δ before .*BREACH report transaction/ })).toHaveAttribute("href", /\/tx\/0x/);
    await expect(page.getByRole("link", { name: /to BROKEN/ })).toHaveAttribute("href", /\/tx\/0x/);
    await expectEverySourced(page.locator("main, body").first(), 8);
  });

  test("public status page", async ({ page }) => {
    await page.goto("/t/kETH");
    await expect(page.getByTestId("delta-readout")).toBeVisible();
    await expect(page.getByRole("link", { name: /^Epoch \d+, its report transaction/ })).toHaveAttribute("href", /\/tx\/0x/);
    await expectEverySourced(page.locator("body"), 10);
  });

  test("landing live cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("landing-live-status")).toBeVisible();
    await expect(page.getByRole("link", { name: /Ethereum Sepolia escrow balance on the explorer/ }).first()).toBeVisible();
    await expectEverySourced(page.locator("body"), 8);
  });
});

test.describe("Δ history incident markers", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("five incidents in 24h: dots on the line, legend labels never overlap", async ({ page }) => {
    await page.goto("/app/tokens/kETH?scenario=incidents-24h&stage=1");
    const legend = page.getByTestId("incident-legend");
    await expect(legend).toBeVisible();
    const labels = legend.getByTestId("incident-marker-label");
    await expect(labels).toHaveCount(5);
    await expect(page.locator("[data-incident-dot]")).toHaveCount(5);

    const boxes = await labels.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
    const axis = await page.locator(".recharts-xAxis").first().evaluate((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (let i = 0; i < boxes.length; i += 1) {
      expect(overlaps(boxes[i]!, axis), `label ${i + 1} overlaps the x-axis`).toBe(false);
      for (let j = i + 1; j < boxes.length; j += 1) expect(overlaps(boxes[i]!, boxes[j]!), `labels ${i + 1} and ${j + 1} overlap`).toBe(false);
    }

    // The data table lists every incident with its link.
    await page.getByRole("group", { name: "Δ history view" }).getByRole("button", { name: "Table" }).click();
    const incidentLinks = page.getByRole("link", { name: /^Incident \d+, 0x/ });
    expect(await incidentLinks.count()).toBeGreaterThanOrEqual(5);
    const numbers = new Set(await incidentLinks.evaluateAll((els) => els.map((el) => el.getAttribute("href"))));
    expect(numbers.size).toBe(5);
  });
});
