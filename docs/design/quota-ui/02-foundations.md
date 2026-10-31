# Foundations: tokens every component uses

Closes: pill control styles, small grey text, detail type sizes, low red vs coral, saved amber dot, partial vs stale dot, control heights. Every value on the page comes from this file; a component that needs another value changes this file first. Research references are `[R§n]` → `13-research.md`.

## Spacing

The 4px-based scale already in `src/styles/variables.scss` [R§11]:

| Token | px | Use |
|---|---|---|
| `space-1` | 4 | icon-to-text, label-to-value |
| `space-2` | 8 | inside a control group, between chips |
| `space-3` | 12 | between fact rows, inside notices |
| `space-4` | 16 | card padding on narrow, between groups inside a card |
| `space-6` | 24 | card padding on wide, between cards |
| `space-8` | 32 | between page regions |

The gap between groups is always at least one step larger than the gap inside them.

## Type

Six styles. Nothing else. Line height is size + 4–6px [R§11].

| Token | Size / line | Weight | Colour | Use |
|---|---|---|---|---|
| `type-page` | 24 (28 ≥ 1280px) / 32 | 600 | primary | page title |
| `type-display` | 40 / 44 | 600, tabular | primary | the one headline number per card [R§2: dedicated metric style] |
| `type-title` | 16 / 22 | 600 | primary | card titles |
| `type-section` | 13 / 18 | 600 | secondary | section headings inside a card or page: "Weekly forecast", "Accounts", "About this data" |
| `type-body` | 14 / 20 | 400 (500 for values) | primary | values, sentences, controls, table cells |
| `type-label` | 13 / 18 | 400 | secondary | labels, captions, asides, meta, axis ticks |

- `font-variant-numeric: tabular-nums` on every number [R§4].
- Nothing is smaller than 13px.
- Weight carries one meaning each: 600 = a title, a section heading or the headline number; 500 = a value; 400 = everything else. Weight never marks a column as special (use a text tag).
- Sentence case everywhere; no colons after labels [R§1].

## Colour

### Surfaces and text (theme tokens, `src/styles/themes.scss`; no hex in components)

| Role | Token | Contrast on card |
|---|---|---|
| Page | `--bg-secondary` | — |
| Card | `--bg-primary` (#101010) | — |
| Inset: open row, notice fill base | `--bg-subtle` (#191919) | — |
| Control fill / hover / pressed | `--bg-tertiary` / `--bg-hover` / `--bg-pressed` | — |
| Skeleton (new) | `--skeleton-bg` #171717 + shimmer | distinct from control fill so skeletons never look like disabled buttons |
| Primary text | `--text-primary` | 16:1 |
| Secondary text, labels | `--text-secondary` (#b5b5b5) | 9.3:1 |
| Muted values (stale, n/a) | `--text-quaternary` (#888) | 5.4:1 (5.0:1 on insets) |
| Hairline / control border | `--border-color` / `--border-primary` | — |

### Meaning: each colour means one thing [R§12]

| Meaning | Colour | Icon (Lucide) | Never used for |
|---|---|---|---|
| Claude series | `--claude-color` coral #ed9877 | provider mark | status |
| Codex series | `--codex-color` blue #83adff | provider mark | status, focus, info |
| Critical: low quota, request failed | new `--critical-color` #ff4d6d (crimson; ΔE 42.6 from Claude coral, 5.9:1). The app's `--error-color` #f2766b is only ΔE 19.6 from coral, so it can't be used here | `alert-triangle` (low), `x-circle` (failed) | partial or stale data |
| Warning: partial data | `--warning-color` amber | `circle-half` (◐) | saved data |
| Warning: stale data | `--warning-color` amber | `clock` (◷) | saved data |
| Info: collecting, not summed, no limit | `--text-secondary` grey | `info` | anything alarming |
| Saved (showing pre-failure data) | `--text-secondary` grey | `history` | — |
| Focus | `--text-primary` white ring, 2px, 2px offset | — | provider series |

- Every status carries a word and an icon; no two statuses share an icon [R§8].
- "Ready" has no colour: when a card's forecast is ready, no status chip is shown (the slot is reserved so nothing moves).
- Notice fill = the tone colour mixed 10% into `--bg-primary`, with a 3px left rule in the tone colour.

### Dimming (stale rows)

Stale values use `--text-quaternary`. Stale bars are drawn at the lowest mix with the card that keeps ≥ 3:1 against the track [R§10]: provider colours at 70% (3.8:1), critical red at 85%. Icons stay full strength.

## Shape

| Token | Value | Use |
|---|---|---|
| `radius-control` | 999px | buttons, selects, inputs, chips, segmented controls |
| `radius-card` | 16px | cards, notices, page panels, empty/error states |
| `radius-inset` | 8px | open-row band, plot area, skeleton blocks |

## Control sizes

One height per pointer type across the page [R§11, R§9]:

| Token | Fine pointer | Coarse pointer |
|---|---|---|
| `control-md` (every button, select, input, chip, segment) | 36px | 44px |
| `control-icon` (icon-only buttons) | 32 × 32 | 44 × 44 |
| Table row | 40px | 48px |

Inputs and selects share the button height, radius, border and fill. One secondary button style, one primary (white fill, used once per state), links styled as links.

## Icons and motion

- Lucide, 16px in text and facts, 18px in icon buttons, 2px stroke. Disabled: 40% opacity, hit area kept.
- 150ms ease for hover/press, 240ms for disclosure. Under `prefers-reduced-motion`, spinners and shimmer slow to a gentle opacity pulse rather than stopping [R§5].
