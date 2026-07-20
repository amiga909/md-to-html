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
| `--no-assets` | Don't copy non-markdown files (e.g. `images/`) to the output directory |
| `--inline-images` | Embed local images as base64 `data:` URIs directly in the HTML |
| `--inline-images-max <mb>` | Max MB of image file bytes to inline per HTML file (default: 10); images over budget keep their file reference |
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
  inlineImages: false, // default; set true to embed images as data URIs
  inlineImagesMaxMB: 10, // default budget per HTML file
  quiet: false, // default
});
```

### Inlining images

With `--inline-images` (or `"inlineImages": true` in the config), local images referenced from the Markdown are embedded into the HTML as base64 `data:` URIs, so each page is a single self-contained file — combine with `--no-assets` to skip copying the `images/` folder entirely. Trade-offs: base64 adds ~33% to image size, and shared images are duplicated into every page instead of being cached once by the browser. Images are inlined in order of appearance until the per-file budget (default 10 MB of image file bytes) is reached; the rest keep their original `src`.

## What it does

- Converts every `*.md` file in the input directory to a self-contained `*.html` file (offline export, no CDN dependencies).
- Injects the configured header/footer into each page.
- Adds `target="_blank" rel="noopener noreferrer"` to external links.
- Adds a subtle bottom border to `h2` headings (GitHub style).
- Copies all non-markdown files and folders (images, PDFs, …) from input to output, unless `--no-assets` is set.

## License

ISC
