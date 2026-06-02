import { expect, test } from "@playwright/test";

const mockApiBaseUrl = "http://127.0.0.1:56012";

function getTranslateX(transform: string) {
  if (transform === "none") {
    return 0;
  }

  const values = transform.match(/matrix(3d)?\((.+)\)/);
  if (!values) {
    return 0;
  }

  const entries = values[2].split(",").map((value) => Number(value.trim()));
  return Number(values[1] ? entries[12] : (entries[4] ?? 0));
}

test.describe("mobile workflows", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page, request, isMobile }) => {
    test.skip(!isMobile, "Mobile-only tests");
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

    await expect(page.locator(".chat-header-agent .eyebrow")).toHaveText(
      "Release planner"
    );
    await expect(
      page.locator(".mobile-nav").getByRole("button", { name: "Chat" })
    ).toBeVisible();

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

  test("animates the segmented toggle highlight with CSS when the pressed option changes", async ({
    page,
  }) => {
    await page.goto("/");

    const toggle = page.locator(".chat-header .mode-toggle");
    const fastButton = page.getByRole("button", { name: "Fast" });
    const thinkButton = page.getByRole("button", { name: "Think" });
    await expect(toggle).toBeVisible();
    const startsOnFast =
      (await fastButton.getAttribute("aria-pressed")) === "true";
    const targetButton = startsOnFast ? thinkButton : fastButton;
    const returnButton = startsOnFast ? fastButton : thinkButton;

    const initialTransform = await toggle.evaluate(
      (element) => getComputedStyle(element, "::before").transform
    );
    const initialTranslateX = getTranslateX(initialTransform);

    await targetButton.click();

    await expect(targetButton).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => {
        const translateX = getTranslateX(
          await toggle.evaluate(
            (element) => getComputedStyle(element, "::before").transform
          )
        );
        return Math.abs(translateX - initialTranslateX) > 20;
      })
      .toBe(true);

    await returnButton.click();
    await expect(returnButton).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => {
        const translateX = getTranslateX(
          await toggle.evaluate(
            (element) => getComputedStyle(element, "::before").transform
          )
        );
        return Math.abs(translateX - initialTranslateX) <= 1;
      })
      .toBe(true);
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

  test("keeps the mobile chat header visible while scrolling on mobile", async ({
    page,
  }) => {
    await page.goto("/");

    const composer = page.getByRole("textbox", { name: "Message composer" });
    await composer.fill(
      [
        "Long mobile scroll request",
        "",
        "Please send a long mobile scroll response so I can verify the sticky composer and the collapsing mobile chat chrome.",
        "",
        "long mobile scroll",
      ].join("\n")
    );
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({
      timeout: 10000,
    });
    await page.getByRole("button", { name: "Send" }).click();

    const timeline = page.locator(".timeline");
    await expect
      .poll(() =>
        timeline.evaluate(
          (element) => element.scrollHeight - element.clientHeight
        )
      )
      .toBeGreaterThan(400);

    await expect(page.locator(".mobile-top-chrome")).toBeVisible();
    await expect(page.locator(".chat-header")).toBeVisible();
    const chatHeader = page.locator(".chat-header");
    const expandedHeaderHeight = await chatHeader.evaluate((element) =>
      Math.round(element.getBoundingClientRect().height)
    );

    await timeline.evaluate((element) => {
      element.scrollTop = 220;
    });

    await expect(chatHeader).toBeVisible();
    await expect
      .poll(() =>
        chatHeader.evaluate((element) =>
          Math.round(element.getBoundingClientRect().height)
        )
      )
      .toBeGreaterThanOrEqual(expandedHeaderHeight - 8);
    await expect(page.locator(".mobile-top-chrome")).toBeVisible();

    const composerInset = await page
      .locator(".composer")
      .evaluate((element) =>
        Math.round(window.innerHeight - element.getBoundingClientRect().bottom)
      );
    expect(Math.abs(composerInset)).toBeLessThanOrEqual(24);

    await timeline.evaluate((element) => {
      element.scrollTop = 0;
    });

    await expect
      .poll(() =>
        chatHeader.evaluate((element) =>
          Math.round(element.getBoundingClientRect().height)
        )
      )
      .toBeGreaterThanOrEqual(expandedHeaderHeight - 8);
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
    request,
  }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Show details" }).click();
    await page.getByLabel("Gemma preset").selectOption("gemma4-deep");
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Chat" })
      .click();
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

    const metricsResponse = await request.get(
      `${mockApiBaseUrl}/api/test/metrics`
    );
    expect(metricsResponse.ok()).toBe(true);
    const metrics = (await metricsResponse.json()) as {
      lastChatConfig: {
        lmStudioEnableThinking: boolean;
        maxCompletionTokens: number;
        model: string;
        presetId: string;
        provider: string;
      } | null;
    };
    expect(metrics.lastChatConfig).toEqual({
      provider: "lmstudio",
      model: "google/gemma-4b-it",
      presetId: "gemma4-deep",
      lmStudioEnableThinking: false,
      maxCompletionTokens: 8192,
    });
  });

  test("forwards prompts through the LM Studio golden path", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    const prompt = "Summarize the mobile release plan.";
    const composer = page.getByRole("textbox", { name: "Message composer" });
    await composer.pressSequentially(prompt);
    const sendButton = page.getByRole("button", { name: "Send" });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    const assistantCard = page.locator(".message-card.assistant").last();
    await expect(
      assistantCard.getByText("Streaming reply for google/gemma-4b-it")
    ).toBeVisible();
    await expect(assistantCard.getByText("mobile: wrapped")).toBeVisible();

    const metricsResponse = await request.get(
      `${mockApiBaseUrl}/api/test/metrics`
    );
    expect(metricsResponse.ok()).toBe(true);
    const metrics = (await metricsResponse.json()) as {
      chatRequestCount: number;
      lastChatConfig: {
        lmStudioEnableThinking: boolean;
        maxCompletionTokens: number;
        model: string;
        presetId: string;
        provider: string;
      } | null;
      lastChatPrompt: string | null;
    };
    expect(metrics.chatRequestCount).toBe(1);
    expect(metrics.lastChatPrompt).toBe(prompt);
    expect(metrics.lastChatConfig).toEqual({
      provider: "lmstudio",
      model: "google/gemma-4b-it",
      presetId: "gemma4-balanced",
      lmStudioEnableThinking: true,
      maxCompletionTokens: 4096,
    });
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
    ).not.toBeVisible();

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
    await expect(
      page.getByRole("dialog", { name: "Quick actions" })
    ).not.toBeVisible();

    await page.getByRole("button", { name: "Show details" }).click();
    await expect(
      page.getByRole("heading", { name: "Agent console" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Model details" })
    ).toBeVisible();

    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Chat" })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("button", { name: "Agents" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page
        .locator("#app-section-agents")
        .getByRole("heading", { name: "Gemma Agent" })
    ).toBeVisible();
  });

  test("hides the details panel when closed and supports moving chat history to Trash", async ({
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
      page
        .locator(".message-card.assistant")
        .last()
        .getByText("mobile: wrapped")
    ).toBeVisible();
    const timeline = page.locator(".timeline");
    await timeline.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => timeline.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(8);
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

    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "History" })
      .click();
    await expect(
      page
        .locator("#app-section-history")
        .getByText("Start a new thread for this agent to create local history.")
    ).toBeVisible();
  });
}); // end mobile workflows

test.describe("desktop layout and keyboard shortcuts", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page, request, isMobile }) => {
    test.skip(isMobile, "Desktop-only tests");
    await request.post(`http://127.0.0.1:56012/api/test/reset`);
    await page.goto("/");
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.reload();
    await page.bringToFront();
    await expect(page.locator(".app-toolbar")).toBeVisible();
  });

  test("shows all panels side-by-side on desktop", async ({ page }) => {
    await expect(page.locator(".app-toolbar")).toBeVisible();
    await expect(page.locator("#app-section-agents")).toBeVisible();
    await expect(page.locator("#app-section-history")).toBeVisible();
    await expect(page.locator("#app-section-chat")).toBeVisible();
    await expect(page.locator(".mobile-top-chrome")).not.toBeVisible();
  });

  test("opens and closes the command palette with keyboard on desktop", async ({
    page,
  }) => {
    await page.locator(".toolbar-brand").click();
    await page.keyboard.press("Control+K");
    await expect(
      page.getByRole("dialog", { name: "Quick actions" })
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement?.getAttribute("aria-label") ===
            "Search commands"
        )
      )
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Quick actions" })
    ).not.toBeVisible();
  });

  test("opens and closes the help dialog on desktop", async ({ page }) => {
    await page.locator(".toolbar-brand").click();
    await page.keyboard.press("?");
    await expect(
      page.getByRole("dialog", { name: "Shortcuts and quick tips" })
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Shortcuts and quick tips" })
    ).not.toBeVisible();
  });

  test("shows and hides the details panel on desktop", async ({ page }) => {
    await expect(page.locator("#app-section-details")).not.toBeAttached();

    await page.getByRole("button", { name: "Show details" }).click();
    await expect(page.locator("#app-section-details")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Model details" })
    ).toBeVisible();

    await page
      .locator("#app-section-details")
      .getByRole("button", { name: "Hide details" })
      .click();
    await expect(page.locator("#app-section-details")).not.toBeAttached();
  });

  test("streams a chat reply on desktop without horizontal overflow", async ({
    page,
  }) => {
    const composer = page.getByRole("textbox", { name: "Message composer" });
    await composer.fill("Summarize the desktop release plan.");
    await page.getByRole("button", { name: "Send" }).click();

    const chatPanel = page.getByRole("main");
    await expect(
      chatPanel.getByText("Streaming reply for google/gemma-4b-it")
    ).toBeVisible();

    const overflowWidth = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflowWidth).toBeLessThanOrEqual(1);
  });
});
