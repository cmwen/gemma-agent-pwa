import { expect, test } from "@playwright/test";

test("streams Gemma Fast replies cleanly on mobile without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Release planner" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();

  await page.getByRole("button", { name: "Fast" }).click();
  await page.getByRole("textbox").fill("Summarize the mobile release plan.");
  await page.getByRole("button", { name: "Send" }).click();

  const chatPanel = page.getByRole("main");
  await expect(
    chatPanel.getByText("Streaming reply for google/gemma-4b-it")
  ).toBeVisible();
  await expect(chatPanel.getByText("thinking: off")).toBeVisible();
  await expect(chatPanel.getByText("tokens: 2048")).toBeVisible();
  await expect(
    chatPanel.getByRole("cell", { name: "Mobile friendly" })
  ).toBeVisible();

  const overflowWidth = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflowWidth).toBeLessThanOrEqual(1);
});
