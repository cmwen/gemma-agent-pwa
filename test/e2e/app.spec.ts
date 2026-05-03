import { expect, test } from "@playwright/test";

const mockApiBaseUrl = "http://127.0.0.1:56012";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, request }) => {
  await request.post(`${mockApiBaseUrl}/api/test/reset`);
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
});

test("streams quick replies cleanly on mobile without horizontal overflow", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Release planner" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();

  await page.getByRole("button", { name: "Fast" }).click();
  const composer = page.getByRole("textbox", { name: "Message composer" });
  await composer.fill("Summarize the mobile release plan.");
  await page.getByRole("button", { name: "Send" }).click();

  const chatPanel = page.getByRole("main");
  await expect(
    chatPanel.getByText("Streaming reply for google/gemma-4b-it")
  ).toBeVisible();
  await expect(chatPanel.getByText("thinking: off")).toBeVisible();
  await expect(chatPanel.getByText("tokens: 4096")).toBeVisible();
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

test("keeps the mobile timeline scroll position when reading a long streamed reply", async ({
  page,
}) => {
  await page.goto("/");

  const composer = page.getByRole("textbox", { name: "Message composer" });
  await composer.fill(
    [
      "Long mobile scroll request",
      "",
      "Please send a long mobile scroll response so I can review the earlier text while the reply is still streaming.",
      "",
      "long mobile scroll",
    ].join("\n")
  );
  await page.getByRole("button", { name: "Send" }).click();

  const timeline = page.locator(".timeline");
  await expect
    .poll(() =>
      timeline.evaluate(
        (element) => element.scrollHeight - element.clientHeight
      )
    )
    .toBeGreaterThan(400);
  await expect
    .poll(() =>
      page
        .locator(".message-card.assistant")
        .last()
        .evaluate(
          (element) => element.textContent?.includes("Paragraph 5:") ?? false
        )
    )
    .toBe(true);

  await timeline.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "touch",
      })
    );
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect
    .poll(() => timeline.evaluate((element) => element.scrollTop))
    .toBeLessThanOrEqual(8);
  await expect(composer).not.toBeFocused();
  await page.waitForTimeout(300);

  const finalScrollTop = await timeline.evaluate(
    (element) => element.scrollTop
  );
  const maxScrollTop = await timeline.evaluate(
    (element) => element.scrollHeight - element.clientHeight
  );
  expect(finalScrollTop).toBeLessThanOrEqual(8);
  expect(maxScrollTop).toBeGreaterThan(400);
});

test("keeps reasoning traces readable on mobile after the final assistant response", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Think" }).click();
  const composer = page.getByRole("textbox", { name: "Message composer" });
  await composer.fill("Explain the mobile rendering tradeoffs.");
  await page.getByRole("button", { name: "Send" }).click();

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

test("renders skill calls as expandable sections instead of raw markup", async ({
  page,
}) => {
  await page.goto("/");

  const composer = page.getByRole("textbox", { name: "Message composer" });
  await composer.pressSequentially("Use the release checklist skill.");
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  const skillCall = page.locator(".skill-activity-details");
  await expect(skillCall).toBeVisible();
  await expect(page.getByText("<skill_call")).toHaveCount(0);

  await skillCall.getByText("Skill call · release-checklist").click();
  await expect(skillCall.getByText("Input")).toBeVisible();
  await expect(skillCall.getByText('{"scope":"mobile"}')).toBeVisible();
  await expect(skillCall.getByText("Result")).toBeVisible();
  await expect(
    skillCall.getByText("Checklist drafted for mobile release.")
  ).toBeVisible();
});

test("uses the thinking toggle without overwriting the selected preset budget", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Show details" }).click();
  await page.getByLabel("Gemma preset").selectOption("gemma4-deep");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByRole("button", { name: "Fast" }).click();

  const composer = page.getByRole("textbox", { name: "Message composer" });
  await composer.fill("Use the deep preset budget with thinking disabled.");
  await page.getByRole("button", { name: "Send" }).click();

  const assistantCard = page.locator(".message-card.assistant").last();
  await expect(
    assistantCard.getByText("Streaming reply for google/gemma-4b-it")
  ).toBeVisible();
  await expect(assistantCard.getByText("thinking: off")).toBeVisible();
  await expect(assistantCard.getByText("tokens: 8192")).toBeVisible();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Details" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agent console" })
  ).toBeVisible();
  await expect(page.getByText("Request queued")).toBeVisible();
  await expect(page.getByText("Response saved")).toBeVisible();
});

test("persists theme changes and supports keyboard shortcuts on mobile", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator(".app-toolbar")).toBeHidden();
  await expect(
    page.getByRole("button", { name: /Command palette/i })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /shortcuts and help/i })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Agent console" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Model details" })
  ).toHaveCount(0);

  await page.getByRole("button", { name: /shortcuts and help/i }).click();
  await expect(
    page.getByRole("dialog", { name: "Shortcuts and quick tips" })
  ).toBeVisible();
  await expect(page.getByText("Jump to the composer.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Shortcuts and quick tips" })
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

  await page.getByRole("button", { name: "Show details" }).click();
  await expect(
    page.getByRole("heading", { name: "Agent console" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Model details" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Agents" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "New chat" })).toBeVisible();
});

test("hides the details panel when closed and supports soft-deleting chat history", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.locator("#app-section-details")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Model details" })
  ).toBeVisible();

  await page
    .locator("#app-section-details")
    .getByRole("button", { name: "Hide details" })
    .click();
  await expect(page.locator("#app-section-details")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Model details" })
  ).toHaveCount(0);

  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Details" })
    .click();
  await expect(page.locator("#app-section-details")).toBeVisible();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Chat" })
    .click();

  const composer = page.getByRole("textbox", { name: "Message composer" });
  await composer.fill("Create a thread so history actions are available.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.locator(".message-card.assistant").last().getByText("mobile: wrapped")
  ).toBeVisible();
  await expect(
    page
      .locator("#app-section-chat")
      .getByRole("button", { name: "Move to Trash" })
  ).toBeVisible();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page
    .locator("#app-section-chat")
    .getByRole("button", { name: "Move to Trash" })
    .click();

  await expect(
    page.getByText("Start a new thread for this agent to create local history.")
  ).toBeVisible();

  await page.getByRole("button", { name: "Trash" }).click();
  await page
    .locator("#app-section-history .session-card-button")
    .first()
    .click();
  await expect(
    page.locator("#app-section-chat").getByRole("button", { name: "Restore" })
  ).toBeVisible();
  await expect(
    page
      .locator("#app-section-chat")
      .getByRole("button", { name: "Delete forever" })
  ).toBeVisible();
});
