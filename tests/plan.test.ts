import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { advise, audit, planFromReport, applyFixes, fixesForPage } from "../src/index.js";
import { renderTerminal } from "../src/render-terminal.js";

describe("planFromReport / advise", () => {
  it("builds prioritized actions with files and snippets", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-plan-"));
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head><title>Only title</title></head></html>`,
    );
    await fs.writeFile(
      path.join(dir, "about.html"),
      `<html><head><title>About</title></head></html>`,
    );

    const report = await audit(dir, { validateImages: false });
    const plan = planFromReport(report);

    expect(plan.score).toBeLessThan(90);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions[0].priority).toBe(1);
    expect(plan.actions[0].impact).toBeGreaterThan(0);
    expect(plan.actions[0].pages.length).toBe(2);
    expect(plan.actions[0].files.length).toBe(2);
    expect(plan.summary).toMatch(/Fleet score/);
    expect(plan.next.length).toBeGreaterThan(0);

    // Same fix id should be grouped, not one action per page for identical issues
    const ogTitle = plan.actions.find((a) => a.id === "fix-og-title");
    expect(ogTitle?.pages.length).toBe(2);
  });

  it("advise() returns report.plan and defaults offline for folders", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-advise-"));
    await fs.writeFile(
      path.join(dir, "index.html"),
      `<html><head>
        <title>T</title>
        <meta property="og:title" content="T"/>
        <meta property="og:description" content="D"/>
        <meta property="og:image" content="https://not-deployed.example/og.png"/>
        <meta name="twitter:card" content="summary_large_image"/>
        <link rel="canonical" href="https://example.com/"/>
      </head></html>`,
    );

    const { report, plan } = await advise(dir);
    expect(report.plan).toBeDefined();
    expect(plan.actions.length).toBeGreaterThan(0);
    // offline default: no network fetch attempt for missing remote image
    expect(report.pages[0].warnings.some((w) => w.code === "og-image-offline")).toBe(true);
  });

  it("terminal What to do section lists top actions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-todo-"));
    await fs.writeFile(path.join(dir, "index.html"), `<html><head></head></html>`);
    const report = await audit(dir, { validateImages: false });
    const withPlan = { ...report, plan: planFromReport(report) };
    const out = renderTerminal(withPlan);
    expect(out).toContain("What to do:");
  });

  it("agent loop: plan → applyFixes improves score", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipcard-loop-"));
    const file = path.join(dir, "index.html");
    await fs.writeFile(file, `<html><head><title>T</title></head></html>`);

    const before = await audit(dir, { validateImages: false });
    const page = before.pages[0];
    const fixes = fixesForPage(page, before);
    expect(fixes.some((f) => f.snippet)).toBe(true);

    const original = await fs.readFile(file, "utf8");
    await fs.writeFile(file, applyFixes(original, fixes));

    const after = await audit(dir, { validateImages: false });
    expect(after.summary.score).toBeGreaterThan(before.summary.score);
  });
});
