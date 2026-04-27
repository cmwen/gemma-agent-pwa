import { expect, test } from "@playwright/test";

const mockApiBaseUrl = "http://127.0.0.1:56012";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
  await request.post(`${mockApiBaseUrl}/api/test/reset`);
});

test("streams Gemma Fast replies cleanly on mobile without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Release planner" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();

  await page.getByRole("button", { name: "Fast" }).click();
  const composer = page.getByRole("textbox");
  await composer.fill("Summarize the mobile release plan.");
  await composer.press("Control+Enter");

  const chatPanel = page.getByRole("main");
  await expect(
    chatPanel.getByText("Streaming reply for google/gemma-4b-it")
  ).toBeVisible();
  await expect(chatPanel.getByText("thinking: off")).toBeVisible();
  await expect(chatPanel.getByText("tokens: 2048")).toBeVisible();
  await expect(
    chatPanel.getByRole("cell", { name: "Mobile friendly" })
  ).toBeVisible();
  await expect(chatPanel.getByText("wrapInsideCard")).toBeVisible();
  await expect(
    chatPanel.getByText(
      "https://example.com/really/long/mobile/path/that/should/wrap/inside/the/chat/card/without/overflow"
    )
  ).toBeVisible();

  const assistantCard = page.locator(".message-card.assistant").last();
  await expect(assistantCard).toBeVisible();

  const overflowWidth = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflowWidth).toBeLessThanOrEqual(1);

  const cardOverflowWidth = await assistantCard.evaluate(
    (card) => card.scrollWidth - card.clientWidth
  );
  expect(cardOverflowWidth).toBeLessThanOrEqual(1);

  const codeOverflowWidth = await assistantCard
    .locator(".message-body pre")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(codeOverflowWidth).toBeLessThanOrEqual(1);
});

test("keeps reasoning traces readable on mobile after the final assistant response", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Think" }).click();
  const composer = page.getByRole("textbox");
  await composer.fill("Explain the mobile rendering tradeoffs.");
  await composer.press("Control+Enter");

  const assistantCard = page.locator(".message-card.assistant").last();
  await expect(assistantCard.getByText("thinking: on")).toBeVisible();

  const reasoning = assistantCard.locator(".thinking-details");
  await expect(reasoning).toBeVisible();
  await reasoning.getByText("Reasoning trace").click();
  await expect(
    reasoning.getByText("Compare the mobile layout before shipping.")
  ).toBeVisible();

  const overflowMetrics = await assistantCard.evaluate((card) => ({
    card: card.scrollWidth - card.clientWidth,
    body: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflowMetrics.card).toBeLessThanOrEqual(1);
  expect(overflowMetrics.body).toBeLessThanOrEqual(1);
});

test("persists theme changes and supports keyboard shortcuts on mobile", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("button", { name: /Command palette/i })
  ).toBeVisible();
  await expect(page.getByText("Press / to focus the composer.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Model details" })
  ).toHaveCount(0);

  const initialTheme = await page.evaluate(
    () => document.documentElement.dataset.theme
  );
  await page.getByRole("button", { name: /Switch to .* theme/i }).click();

  const toggledTheme = await page.evaluate(
    () => document.documentElement.dataset.theme
  );
  expect(toggledTheme).toBeTruthy();
  expect(toggledTheme).not.toBe(initialTheme);

  await page.reload();
  await expect(
    page.getByRole("button", { name: /Switch to .* theme/i })
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(toggledTheme);

  await page.keyboard.press("/");
  await expect(
    page.getByRole("textbox", { name: "Message composer" })
  ).toBeFocused();

  await page.keyboard.press("Control+K");
  await expect(
    page.getByRole("dialog", { name: "Quick actions" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick actions" })).toHaveCount(
    0
  );

  await page.getByRole("button", { name: "Model details" }).click();
  await expect(
    page.getByRole("heading", { name: "Model details" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Agents" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
});
