# actually-free-tools

A collection of small, single-purpose web tools that got paywalled, ad-stuffed or
turned into a signup funnel elsewhere. The index at `/` is a landing page; each
tool lives in its own directory.

## The hosting constraint

**Everything here has to be extremely small and cheap to host — that is the point,
not a nice-to-have.** The site must stay servable as plain static files from any
host (GitHub Pages, Cloudflare Pages, Netlify, S3, a USB stick) with a free tier
that never gets close to being exceeded. Concretely:

- **No build step.** What's in the repo is what gets served. No bundler, no
  transpiler, no generator, no `npm install` needed to run anything.
- **No backend, no database, no serverless functions.** Work happens in the
  browser. If a tool genuinely can't work client-side, that's a discussion to
  have before it's built, not a thing to quietly add a server for.
- **No runtime dependencies.** No CDN scripts, no npm packages shipped to the
  browser, no frameworks. Vanilla HTML/CSS/JS. Dev-only dependencies for
  generating test fixtures are fine, and stay out of the served output.
- **No web fonts.** System font stacks only (`system-ui`, and `ui-monospace` for
  the mono stack, both already set up in `assets/site.css`).
- **No images.** Icons are inline SVG or a small `.svg` file. No PNG/JPG assets,
  no icon fonts, no sprite sheets.
- **No third-party anything.** No analytics, no tag managers, no fonts, no embeds,
  no cookie banner (because there are no cookies). Pages should make zero network
  requests after load — several carry a `connect-src 'none'` CSP saying so.
- **Relative paths everywhere.** Never absolute (`/assets/...`) — the site must
  work when served from a subpath and when opened straight off disk.

Rough budget to stay under: **under 100 KB of HTML+CSS+JS per tool page**, and no
page needing more than a handful of requests. If something wants to blow through
that, it probably wants a different home.

## Structure

```
index.html            landing page — cards linking to each tool
favicon.svg           one mark for the whole site
assets/site.css       shared shell: tokens, chrome, form controls, buttons, cards
qr-barcode/           one directory per tool
  index.html
  tool.css            only what's specific to this tool
  qrcode.js  barcode.js  render.js  app.js
tests/                test suite and reference vectors
```

Pages link to a tool as `qr-barcode/` (directory index), so URLs stay clean and
the folder can be renamed without touching filenames.

## Adding a tool

1. Create `<tool-slug>/` at the repo root with `index.html` and, if needed,
   `tool.css` for layout that isn't already in the shell.
2. In its `<head>`: link `../assets/site.css` first, then `tool.css`; set
   `../favicon.svg`; add a `<meta name="description">`; add the CSP meta if the
   tool makes no network requests.
3. Use the shell's markup conventions — `.site-bar` with the wordmark linking to
   `../`, `.page-header` with a `.crumb` back-link, `.panel` on boxed sections,
   `.field`/`.row` for form controls, `.btn`/`.btn.primary` for actions,
   `.site-footer` at the bottom. Copy `qr-barcode/index.html` as the reference.
4. Add a card to the root `index.html` (there's a template comment next to the
   existing one), and drop the ghost placeholder card once the grid is full.
5. Put logic in files with no DOM dependency where you can, and export under both
   `window` and CommonJS (see `qr-barcode/qrcode.js`) so tests can require them
   from Node without a bundler.
6. Add tests to `tests/` if the tool has anything worth being correct about.

## Design

Defined once in `assets/site.css`; don't redeclare tokens in a tool stylesheet.

- Warm-neutral surfaces, near-black ink for filled controls, a teal `--link`
  used sparingly for links, focus rings and hover accents.
- Light and dark via `prefers-color-scheme` on `:root` — every colour must come
  from a token so both themes stay correct for free.
- Restrained on purpose: hairline borders, no shadows, no gradients, no
  animation beyond a 120ms hover transition. It should read as a well-made
  utility, not a SaaS landing page.

## Product rules

These are the pitch, so they aren't negotiable per-tool:

- No accounts, no email capture, no "sign in to download".
- No uploads. Nothing leaves the browser unless a tool fundamentally can't work
  that way, and then it says so plainly on the page.
- No watermarks, no trial tiers, no degraded free output.
- No tracking of any kind, including "just" a page-view counter.
- No indirection that gives us leverage over the user later — the QR generator's
  refusal to encode a redirect domain is the model for this.
- Source stays readable. Someone should be able to open a file and follow it.

## Testing

```
node tests/test.mjs
```

No dependencies. Regenerating the QR/barcode reference vectors needs Python and
is documented in `README.md`; the vectors are committed so the suite runs on a
clean checkout.
