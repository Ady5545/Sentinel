---
name: dual-strategy-dark-mode
description: Universal guide and bug registry for implementing, auditing, and fixing dark mode in applications using dual styling strategies (e.g. Tailwind CSS utility classes vs CSS custom property tokens across web/mobile). Covers proven token patterns, common traps, and multi-surface parity.
---

# Dual-Strategy Dark Mode — Universal Implementation Guide & Bug Registry

## Overview

When building cross-platform or dual-surface applications (such as a desktop web app and a mobile PWA, or a hybrid React + React Native / CSS token architecture), dark mode often spans two distinct styling paradigms:

1. **Utility-Class Strategy (e.g., Tailwind CSS `dark:` classes):** Direct utility classes toggled via an ancestor `.dark` class or media query.
2. **Design-Token Strategy (e.g., CSS Custom Properties / `var(--...)`):** Semantic variables declared at root or container scopes that dynamically adapt when theme attributes switch.

> [!IMPORTANT]
> **Strict Isolation Invariant:** Never mix the two strategies inside the same component layer. If a surface relies on semantic CSS custom properties, avoid sprinkling hardcoded utility overrides (`dark:bg-[...]`), as this breaks the theme cascade and theme token inheritance.

---

## Universal Token Architecture

### 1. Semantic Token Mapping (Light vs Dark)

| Semantic Role | Typical Light-Mode Value | Typical Dark-Mode Value |
|---|---|---|
| Primary Surface | `#FFFFFF` / `bg-white` | Deep Slate / `#12161B` / `#0F172A` |
| Secondary / Card Surface | Light Gray / `#F8FAFC` | Elevated Dark / `#181D23` / `#1E293B` |
| Page Background | Off-White / Soft Tint | Pure/Near Dark / `#0B0D10` |
| Nav / Elevated Surface | Translucent White (`white/90`) | Translucent Dark (`dark/90`) |
| Subtle Divider / Border | `border-slate-200` | `border-slate-800` |
| Primary Typography | High-contrast Black/Navy | Crisp White / `text-[#F5F7FA]` |
| Secondary / Muted Text | Medium Gray (`text-slate-500`) | Muted Silver (`text-slate-400`) |
| Accent / Highlight | Vivid Primary (`#0066FF`) | High-Luminance Cyan/Accent (`#22C7D6`) |
| Accent Border / Selected | Light Accent Border | Dark Accent Border |
| Accent Background Tint | Soft Tint (`bg-sky-50`) | Low-opacity Accent (`bg-accent/10`) |

### 2. CSS Custom Property Token Pattern

```css
:root {
  --surface-1: #FFFFFF;
  --surface-2: #F8FAFC;
  --text-primary: #090D1A;
  --text-secondary: #64748B;
  --border-subtle: #E2E8F0;
  --accent: #0066FF;
}

[data-theme="dark"],
.dark {
  --surface-1: #12161B;
  --surface-2: #181D23;
  --text-primary: #F5F7FA;
  --text-secondary: #94A3B8;
  --border-subtle: #1E293B;
  --accent: #22C7D6;
}
```

---

## Universal Bug Registry — Common Pitfalls & Solutions

### Bug 1: Layout Shift / Jitter on Theme Toggle
- **Symptom:** Page height, navigation bar, or layout jumps by several pixels when toggling themes.
- **Root Cause:** Conditional layout or dimensional classes based on theme (e.g. `isDark ? 'h-16' : 'h-14'`).
- **Fix:** Keep structural/dimensional classes identical between modes. Never branch `padding`, `margin`, or `height` on theme state.

### Bug 2: Hardcoded SVG Stroke & Fill Colors
- **Symptom:** Vector graphics, icons, or decorative wave crests display harsh light-colored borders in dark mode.
- **Root Cause:** SVG inline attributes like `stroke="#FFFFFF"`, `fill="#000"`, or `<stop stop-color="...">` bypass CSS inheritance.
- **Fix:** Bind SVG color attributes to reactive theme hooks (e.g. `stroke={isDark ? '#22C7D6' : '#E0F2FE'}`) or use CSS `currentColor` / CSS variables inside `svg` paths.

### Bug 3: Animation Libraries Overriding Theme Colors
- **Symptom:** Animated elements (e.g. Framer Motion, GSAP, React Spring) revert to light-mode colors during or after animation.
- **Root Cause:** Inline animation values like `animate={{ color: '#090D1A' }}` create direct inline CSS styles that take precedence over stylesheet dark classes.
- **Fix:** Use `currentColor` or CSS custom properties in animation targets:
  ```tsx
  // ✅ FIXED — respects CSS dark-mode rules
  animate={{ color: isUpdated ? ['currentColor', 'var(--accent)', 'currentColor'] : 'currentColor' }}
  ```

### Bug 4: Modals & Portals Rendering in Default Light Surface
- **Symptom:** Modal dialogues, popovers, or tooltips rendered in a portal container appear bright white in dark mode.
- **Root Cause:** Portals often mount directly to `document.body` outside the DOM subtree that has the `.dark` class, or modal components lack explicit `dark:` background classes.
- **Fix:** Ensure the `.dark` class is attached to the document root (`document.documentElement` or `document.body`), and ensure modal wrappers include dark surface, header, border, and input styles:
  ```tsx
  className="bg-white dark:bg-[#12161B] text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-800"
  ```

### Bug 5: Active / Selected State Contrast Failure
- **Symptom:** Selected tabs, cards, or list items become unreadable or invisible in dark mode.
- **Root Cause:** Active state styling only accounts for light backgrounds (e.g. light blue background with dark blue text, unreadable against dark gray surfaces).
- **Fix:** Define distinct dark active styles with high-contrast foregrounds:
  ```tsx
  className={`... ${selected ? 'border-[#0066FF] dark:border-accent bg-sky-50 dark:bg-accent/15' : 'border-transparent'}`}
  ```

### Bug 6: Mobile / Web Multi-Surface Divergence
- **Symptom:** The desktop app supports dark mode correctly, but the mobile PWA or companion client has unreadable text or mismatched colors.
- **Root Cause:** Independent codebases using divergent token schemes without cross-platform verification.
- **Fix:** Enforce multi-surface verification loops. When auditing or updating dark styles on one surface, verify corresponding views on companion surfaces.

---

## Universal Dark Mode Audit Checklist

When reviewing any component or view for dark-mode readiness:

- [ ] **Surface Container:** Root container has proper dark surface color (`dark:bg-...` or `var(--surface-1)`).
- [ ] **Typography Hierarchy:** Both primary headers and secondary/muted text have dark-mode definitions (`dark:text-white`, `dark:text-slate-400`).
- [ ] **Dividers & Borders:** All borders, card outlines, and horizontal rules adapt (`dark:border-slate-800` or `var(--border-subtle)`).
- [ ] **SVG & Canvas:** Vector strokes, fills, and gradient stops respond to theme state or use `currentColor`.
- [ ] **Animation Properties:** No animation library sets hardcoded inline RGB/HEX color strings without theme-awareness.
- [ ] **Modals, Drawers & Tooltips:** Portals, overlays, and dropdowns inherit dark theme tokens.
- [ ] **Form Controls:** Inputs, selects, radio buttons, and checkboxes have dark backgrounds and readable placeholders.
- [ ] **Layout Stability:** No theme toggle introduces layout shifts, scroll jumps, or reflow.
- [ ] **Multi-Surface Parity:** If the repository serves multiple platforms, verify that dark theme changes are mirrored consistently across all client surfaces.
