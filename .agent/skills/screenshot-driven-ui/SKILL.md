---
name: screenshot-driven-ui
description: Use when modifying, redesigning, or polishing UI components, heroes, carousels, modals, responsive layouts, or theme surfaces — requires an iterative code-build-screenshot-inspect loop with real browser rendering before claiming completion
---

# Screenshot-Driven UI (Visual Feedback Loop)

## Overview

**Core principle:** Visual reality over code assumptions.

CSS classes and JSX structure do not prove how pixels actually render. When modifying interfaces, you must establish an autonomous feedback loop: write code, build, capture real browser screenshots across target viewports, inspect the rendered images directly with `view_file`, critique the visual result, and iterate until the task is completely accomplished.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   SCREENSHOT-DRIVEN VISUAL FEEDBACK LOOP                │
│                                                                        │
│   1. CODE    ──→  2. BUILD   ──→  3. CAPTURE   ──→  4. INSPECT         │
│   (Surgical       (npm run        (Playwright       (view_file         │
│    JSX/CSS)        build)          multi-device)     PNG in context)   │
│                                                            │           │
│   5. CRITIQUE                                              ▼           │
│   - Contrast & legibility (e.g. dark apertures for neon)   │           │
│   - Alignment & responsive wrapping                        │           │
│   - Dynamic states (active card, open modals, menus)       │           │
│                                                            │           │
│   IF DISCREPANCY OR FLAW DETECTED ─────────────────────────┘           │
│   └─→ Tweak code & REPEAT loop until 100% accomplished                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## When to Use

### Use When:
- Implementing, styling, or redesigning web UI components, hero sections, carousels, or dialogs.
- Changing typography, font scales, line heights, or text truncation.
- Introducing or altering light/dark mode surfaces, card backgrounds, or color palettes.
- Fixing responsive layout bugs, overflow issues, or awkward wrapping on laptop/mobile screens.
- Adding or adjusting iconography, brand logos, badges, or neon/glowing assets.

### Do NOT Use When:
- Writing pure backend logic, API routes, database schemas, or CLI scripts.
- Running headless data migrations or unit math functions with no visual footprint.

---

## The 5-Step Iterative Cycle

### 1. Code
Apply surgical changes to the component JSX, CSS, or Tailwind tokens. Keep modifications focused strictly on the user's brief.

### 2. Build & Serve
Compile the real production or dev artifacts:
```bash
npm run build
```
Ensure the server is accessible (e.g. static preview server or Vite dev server).

### 3. Capture
Run a lightweight headless browser runner (Playwright) that navigates to the target route across the **Standard Viewport Matrix** and captures full-resolution PNGs directly to your artifact directory.

```javascript
// scratch/verify-ui.mjs
import { chromium } from 'playwright';

async function capture() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  // Suppress first-visit modal interruptions if needed (e.g. welcome modals or onboarding tours)
  await page.addInitScript(() => {
    localStorage.setItem('app_welcome_seen', 'true');
    localStorage.setItem('app_welcome_dismissed', 'true');
  });

  await page.goto('http://127.0.0.1:5173/');
  await page.waitForTimeout(600); // Allow fonts, transitions, and 3D scenes to settle

  await page.screenshot({ path: `${ARTIFACT_DIR}/desktop-view.png` });

  // Test dynamic interaction states
  const nextBtn = page.getByRole('button', { name: /next/i });
  if (await nextBtn.isVisible()) {
    await nextBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${ARTIFACT_DIR}/desktop-view-next.png` });
  }

  await browser.close();
}
capture().catch(console.error);
```

### 4. Inspect
Open and view the captured PNG files directly using `view_file`:
```
view_file(AbsolutePath="<artifact-dir>/desktop-view.png")
```
Never claim a UI change is done without having inspected the rendered image.

### 5. Critique & Iterate
Audit the image against the visual checklist below. If any defect or contrast issue is observed:
1. Identify the root cause in code (e.g., washed-out cyan mark on white card &rarr; add dark backdrop aperture).
2. Adjust the code.
3. Re-run `npm run build`.
4. Re-run capture script.
5. Re-inspect new screenshot.
6. **Repeat until all criteria are satisfied.**

---

## Standard Viewport Matrix

Always capture across these distinct form factors to guarantee responsive resilience:

| Device Tier | Viewport | Target Checks |
|---|---|---|
| **Primary Laptop / Desktop** | `1440 × 900` | Full header lockup, 3D perspective centering, max-width constraints |
| **Standard Laptop** | `1366 × 768` | Header button wrapping, hero title wrap point, carousel side padding |
| **Compact Laptop** | `1280 × 720` | Tightest desktop container breakpoint, ensure zero horizontal overflow |
| **Modern Phone** | `390 × 844` | Mobile header logo, touch target sizes ($\ge 44\text{px}$), card stacking |
| **Compact Phone** | `375 × 667` | Short viewport vertical scrolling, modal height boundaries, safe area |

---

## Visual Critique Checklist

When inspecting screenshots via `view_file`, check:

1. **Luminance Contrast & Clarity:**
   - Are thin lines, neon glows, or cyan marks clearly visible against their background?
   - *Rule:* If a glowing or light asset sits on a light card, place a localized high-contrast dark aperture/pod *specifically behind the asset*. Do not invert the entire card into an unwanted dual-tone theme.
2. **Theme Cohesion:**
   - Do all cards, inactive states, and surfaces share the same unified theme?
   - Avoid unintentional dual-tone states (e.g. dark inactive cards stacked next to a light active card).
3. **Typography & Truncation:**
   - Are labels clipping, wrapping onto awkward lines, or overlapping?
   - Is text readable at small mobile viewports?
4. **Brand Integrity:**
   - Does the mobile version render the official SVG brand lockup component, not generic text?
5. **Interactive States:**
   - Did clicking 'Next', opening a modal, or switching tabs render smoothly without broken geometry?

---

## Common Pitfalls

| Pitfall | Root Cause | Fix |
|---|---|---|
| Claiming "looks great" without viewing image | Relying on code syntax alone | Call `view_file` on the screenshot before writing your response |
| Testing only 1920×1080 | Missing laptop and mobile constraints | Run Playwright across the 5 viewports in the matrix |
| First-visit modals blocking hero | Fresh local storage in browser context | Use `addInitScript` to pre-seed dismissed flags in test script |
| Server unreachable in Windows sandbox | Cross-process local network isolation | Probe in same command or run verify script with bypass sandbox |
