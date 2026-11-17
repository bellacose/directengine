# Site themes

A theme is a folder here holding a Tailwind file. A site uses it by naming the folder in its config:
`"theme": "ink-cyan"` in `sites/dtf.json`.

## Add or change a theme

1. Make a folder, e.g. `sites/themes/my-theme/`.
2. Put **one** of these in it:
   - `tailwind.config.js` (or `.mjs` / `.ts`): a Tailwind v3 config, e.g. exported from a theme generator.
   - `theme.css`: a Tailwind v4 stylesheet with an `@theme { ... }` block.
3. If the config's colours are links like `var(--primary)` (shadcn, themelab, tweakcn exports), also
   add the CSS file the generator gives you (e.g. `globals.css`). Its `:root { ... }` block supplies the
   values; `.dark` is ignored. A pale `accent` tint is replaced by the first readable colour among
   `--ring`, `--chart-1` and `primary`, since the site uses accent for text. `primary-foreground`
   becomes the button text colour.
4. Optional: drop variable font files in `fonts/`, named after the family: `fonts/Inter.woff2`.
   They are served from the site and used when the config names that family.
5. Set `"theme": "my-theme"` in the site's JSON and run `npm test`.

## What is read

Only these tokens (shadcn-style names). Anything else in the file is ignored.

| v3 config (`theme.extend`)          | v4 `@theme`                | Used for                              |
| ----------------------------------- | -------------------------- | ------------------------------------- |
| `colors.primary`                    | `--color-primary`          | Buttons, theme colour (4.5:1 on white) |
| `colors.accent`                     | `--color-accent`           | Logo mark, cutoff times, arrows        |
| `colors.background` / `foreground`  | `--color-background` / `--color-foreground` | Page and text          |
| `colors.muted` / `muted.foreground` | `--color-muted` / `--color-muted-foreground` | Grey panels / secondary text |
| `colors.border` / `input`           | `--color-border` / `--color-input` | Rules / button and field borders |
| `fontFamily.sans` / `display`       | `--font-sans` / `--font-display` | Body / headings                  |
| `borderRadius.DEFAULT` (or `lg`)    | `--radius`                 | Corners                               |

Colours can be hex, `rgb()`, `hsl()`, `oklch()`, or `var(--x)` links that a CSS file in the folder
defines. The build refuses anything it can't resolve, and colours that would make text hard to read.

## Logo

`"brand": { "logo": { "file": "assets/dtf/logo.svg" } }` (a path inside `sites/`). SVG or PNG. An SVG
is inlined in the header (`currentColor` takes the text colour; elements with `class="logo-accent"`
take the accent colour) and doubles as the favicon. Add `"includesName": true` if the image already
spells the site name.
