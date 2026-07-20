# @romanhatz/md-to-html

Convert a folder of Markdown files to standalone (offline) HTML files, powered by [mume](https://github.com/shd101wyy/mume) with GitHub-light styling. Supports a per-project header and footer, opens external links in a new tab, and copies assets (e.g. an `images/` folder) alongside the generated HTML.

## Install

From a git repository (works without publishing to npm):

```bash
npm install --save-dev git+ssh://git@github.com/romanhatz/md-to-html.git
```

Or, if published to npm:

```bash
npm install --save-dev @romanhatz/md-to-html
```

For local development across projects, you can also use `npm link` in this repo and `npm link @romanhatz/md-to-html` in the consuming project.

## CLI usage

```bash
md-to-html --input ./docs --output ../script --header "My Project" --footer "© 2026 My Project"
```

| Option | Description |
| --- | --- |
| `-i, --input <dir>` | Directory containing `.md` files (required) |
| `-o, --output <dir>` | Directory to write `.html` files to, created if missing (required) |
| `--header <text>` | Header text/HTML rendered at the top of every page |
| `--footer <text>` | Footer text/HTML rendered at the bottom of every page |
| `--no-assets` | Don't copy referenced files (e.g. linked PDFs) to the output directory |
| `--no-clean` | Don't empty the output directory before converting |
| `--no-lightbox` | Don't open image links (click-to-enlarge) in a fullscreen overlay |
| `-c, --config <file>` | Config file (default: `./md-to-html.config.json` if present) |
| `-q, --quiet` | Only print errors |

## Per-project configuration

Put a `md-to-html.config.json` next to your `package.json` (paths are resolved relative to the config file); CLI flags override config values:

```json
{
  "input": "./docs",
  "output": "../script",
  "header": "Project Alpha",
  "footer": "© 2026 Project Alpha"
}
```

Then in the consuming project's `package.json`:

```json
{
  "scripts": {
    "convert": "md-to-html"
  }
}
```

and run `npm run convert`.

## Programmatic usage

```js
const { convert } = require("@romanhatz/md-to-html");

const { converted, failed } = await convert({
  input: "./docs",
  output: "../script",
  header: "Project Alpha",
  footer: "© 2026 Project Alpha",
  assets: true, // default
  clean: true, // default
  lightbox: true, // default
  quiet: false, // default
});
```

## What it does

- Converts every `*.md` file in the input directory **recursively** to a self-contained `*.html` file (offline export, no CDN dependencies), mirroring the folder structure in the output directory.
- **Embeds all local images** as base64 `data:` URIs, so each page is a single self-contained file; images larger than 2 MB are embedded too, with a warning suggesting compression.
- **Cleans the output directory before every run** (disable with `--no-clean`); it refuses to clean a directory that contains the input directory, or a home/root directory.
- Copies **only the files actually referenced** by the generated HTML (linked PDFs, scripts, …) — unreferenced files, images (already embedded), markdown sources, and junk (`node_modules`, `.git`, `.DS_Store`, …) never end up in the output.
- Injects the configured header/footer into each page; the header also shows the source file's folder path as a breadcrumb (e.g. "Day 1 - Exercises").
- Images wrapped in a link (click-to-enlarge) open in a fullscreen lightbox overlay instead of navigating to the image file, which no longer exists since images are embedded (close with click or Escape; disable with `--no-lightbox`).
- Adds `target="_blank" rel="noopener noreferrer"` to external links.
- Adds a subtle bottom border to `h2` headings (GitHub style).
- Copies all non-markdown files and folders (images, PDFs, …) from input to output, unless `--no-assets` is set.

## License

ISC
