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
    await page.addInitScript(() => {
      window.__introPrograms = 0;
      const create = WebGLRenderingContext.prototype.createProgram;
      WebGLRenderingContext.prototype.createProgram = function () {
        window.__introPrograms++;
        return create.call(this);
      };
    });
    await page.goto("http://127.0.0.1:1420");
    await page.waitForSelector('.launch[data-stage="welcome"]');
    if (errors.length) throw Error(errors.join("\n"));
    if (await page.locator(".cosmic-fallback").count())
      throw Error("Shader fell back");
    await page.screenshot({ path: path.join(root, "welcome.png") });
    await page.evaluate(() => {
      const canvas = document.querySelector(".cosmic-field canvas");
      const programCount = window.__introPrograms;
      const samples = [];
      window.__nameFrames = samples;
      const sample = () => {
        const launch = document.querySelector(".launch");
        const rect = canvas.getBoundingClientRect();
        samples.push({
          stage: launch.dataset.stage,
          sameCanvas: canvas === document.querySelector(".cosmic-field canvas"),
          sameProgram: programCount === window.__introPrograms,
          bounds: [rect.x, rect.y, rect.width, rect.height].join(","),
          nameOpacity: document.querySelector(".welcome-name")
            ? Number(getComputedStyle(document.querySelector(".welcome-name")).opacity) : 0,
        });
        if (launch.dataset.stage !== "name") requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.press("Enter");
    await page.waitForSelector('.launch[data-stage="name"]');
    const nameFrames = await page.evaluate(() => window.__nameFrames);
    if (nameFrames.some((frame) => !frame.sameCanvas || !frame.sameProgram))
      throw Error("Continue recreated the animated background");
    if (new Set(nameFrames.map((frame) => frame.bounds)).size !== 1)
      throw Error("Continue moved or resized the background");
    if (!nameFrames.some((frame) => frame.stage === "entering-name" && frame.nameOpacity > 0 && frame.nameOpacity < 1))
      throw Error("Name entry skipped its transition");
    console.log("PASS: first Continue fades within fixed bounds and retains its WebGL program", nameFrames.length, "sampled frames");
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
    await page.evaluate(() => {
      const app = document.querySelector(".launch-app");
      const frames = [];
      window.__launchFrames = frames;
      const sample = () => {
        const launch = document.querySelector(".launch");
        if (!launch) return;
        const rect = app.getBoundingClientRect();
        frames.push({
          stage: launch.dataset.stage,
          opacity: Number(getComputedStyle(launch).opacity),
          greeting: !!launch.querySelector(".welcome-greeting"),
          appVisible: getComputedStyle(app).visibility === "visible",
          sameApp: app === document.querySelector(".launch-app"),
          bounds: [rect.x, rect.y, rect.width, rect.height].join(","),
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".launch"));
    const frames = await page.evaluate(() => window.__launchFrames);
    const fade = frames.filter((frame) => frame.stage === "revealing");
    if (!fade.some((frame) => frame.opacity > 0 && frame.opacity < 1))
      throw Error("Workspace transition skipped its crossfade");
    if (fade.some((frame) => !frame.greeting || !frame.appVisible || !frame.sameApp))
      throw Error("Greeting or mounted workspace disappeared during crossfade");
    if (new Set(frames.map((frame) => frame.bounds)).size !== 1)
      throw Error("Workspace moved during onboarding handoff");
    if (frames.some((frame) => !["name", "greeting", "revealing"].includes(frame.stage)))
      throw Error("Unexpected intermediate handoff stage");
    console.log("PASS: continuous greeting/workspace crossfade", fade.length, "sampled frames");
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
    await page.getByRole("checkbox", { name: "Intro music" }).uncheck();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("brigadier:sample-notes"))
          .launchMusic === false,
    );
    await page.getByRole("button", { name: "Replay welcome" }).click();
    await page.waitForSelector('.launch[data-stage="welcome"]');
    if (await page.getByRole("button", { name: /intro music/i }).count())
      throw Error("Intro sound control still present");
    await page.getByRole("button", { name: "Return to workspace" }).click();
    await page.waitForFunction(() => !document.querySelector(".launch"));
    console.log(
      "PASS: shader, required name, persistence, returning launch, editable settings, mute and replay",
      errors,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("brigadier-settings")));
    await page.getByRole("button", { name: "Reset onboarding" }).click();
    await page.waitForSelector('.launch[data-stage="welcome"]');
    const reset = await page.evaluate(() => JSON.parse(localStorage.getItem("brigadier:sample-notes")));
    if (reset.displayName || reset.nameConfirmed || reset.welcomeCompleted || reset.introSeen)
      throw Error("Reset did not clear onboarding");
    if (reset.launchMusic !== false) throw Error("Reset overwrote music preference");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForSelector('.launch[data-stage="name"]');
    const nameInput = page.getByRole("textbox", { name: "Your name" });
    if (await nameInput.inputValue()) throw Error("Reset retained the old name");
    await nameInput.fill("Ana12🙂");
    if (await nameInput.inputValue() !== "Ana") throw Error("Invalid name characters accepted");
    await nameInput.press("End");
    await nameInput.press("ArrowLeft");
    await nameInput.press("b");
    if (await nameInput.inputValue() !== "Anba") throw Error("Arrow key did not move the caret");
    await page.getByRole("button", { name: "Reset onboarding" }).click();
    await page.waitForSelector('.launch[data-stage="welcome"]');
    console.log("PASS: reset from Settings and onboarding, empty name, filtering and arrow navigation");
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
