const { chromium } = require("playwright");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const root = process.argv[2] || "/tmp/brigadier-intro-check";
mkdirSync(root, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "warning" && m.text().includes("Intro renderer"))
        errors.push(m.text());
    });
    await page.goto("http://127.0.0.1:1420");
    await page.waitForSelector('.launch[data-stage="welcome"]');
    if (errors.length) throw Error(errors.join("\n"));
    if (await page.locator(".cosmic-fallback").count())
      throw Error("Shader fell back");
    await page.screenshot({ path: path.join(root, "welcome.png") });
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Your name" }).fill("   ");
    if (
      !(await page
        .getByRole("button", { name: "Continue", exact: true })
        .isDisabled())
    )
      throw Error("Whitespace name accepted");
    await page.getByRole("textbox", { name: "Your name" }).fill("Stephen");
    await page
      .locator(".welcome-name")
      .evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
    await page.screenshot({ path: path.join(root, "name.png") });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".launch"));
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("brigadier:sample-notes")),
    );
    if (saved.displayName !== "Stephen" || !saved.welcomeCompleted)
      throw Error("Profile not persisted");
    await page.screenshot({ path: path.join(root, "workspace.png") });
    await page.reload();
    await page.waitForSelector(".app");
    if (await page.locator(".welcome-name").count())
      throw Error("Returning user asked for name");
    await page.evaluate(() =>
      window.dispatchEvent(new Event("brigadier-settings")),
    );
    await page
      .getByRole("textbox", { name: "Display name", exact: true })
      .fill("  ");
    if (!(await page.getByRole("button", { name: "Save name" }).isDisabled()))
      throw Error("Settings accepts blank");
    await page
      .getByRole("textbox", { name: "Display name", exact: true })
      .fill("Alex");
    await page.getByRole("button", { name: "Save name" }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("brigadier:sample-notes"))
          .displayName === "Alex",
    );
    await page.getByRole("checkbox", { name: "Launch music" }).uncheck();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("brigadier:sample-notes"))
          .launchMusic === false,
    );
    await page.getByRole("button", { name: "Replay welcome" }).click();
    await page.waitForSelector('.launch[data-stage="welcome"]');
    if (await page.getByRole("button", { name: /launch music/i }).count())
      throw Error("Intro sound control still present");
    await page.getByRole("button", { name: "Return to workspace" }).click();
    await page.waitForFunction(() => !document.querySelector(".launch"));
    console.log(
      "PASS: shader, required name, persistence, returning launch, editable settings, mute and replay",
      errors,
    );
    const reduced = await browser.newPage({
      viewport: { width: 800, height: 500 },
      reducedMotion: "reduce",
      deviceScaleFactor: 2,
    });
    await reduced.goto("http://127.0.0.1:1420");
    await reduced.waitForSelector('.launch[data-stage="welcome"]', {
      timeout: 5000,
    });
    if (await reduced.locator(".cosmic-fallback").count())
      throw Error("Retina shader fell back");
    await reduced
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await reduced.screenshot({ path: path.join(root, "reduced-motion.png") });
    console.log("PASS: reduced-motion welcome is immediate");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
