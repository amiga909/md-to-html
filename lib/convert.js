const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const mume = require("@shd101wyy/mume");

const { MarkdownEngine } = mume;

const DEFAULT_ENGINE_CONFIG = {
  previewTheme: "github-light.css",
  codeBlockTheme: "github.css",
  printBackground: false,
  enableScriptExecution: false,
  breakOnSingleNewLine: true,
  enableTypographer: true,
  enableLinkify: true,
  enableEmojiSyntax: false,
  enableWikiLinkSyntax: false,
  frontMatterRenderingOption: "none",
};

const CUSTOM_CSS = `<style>
      .mume h2 {
        padding-bottom: 0.3em;
        border-bottom: 1px solid #eaecef;
      }
      .md-page-header,
      .md-page-footer {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        color: #24292e;
        padding: 1em 2em;
        margin: 0 auto;
      }
      .md-page-header {
        display: flex;
        align-items: center;
        gap: 0.75em;
        box-sizing: border-box;
        height: 50px;
        padding: 0 2em;
        font-size: 1em;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        border-bottom: 1px solid #eaecef;
      }
      .md-page-footer {
        font-size: 0.85em;
        color: #6a737d;
        border-top: 1px solid #eaecef;
      }
      .md-page-breadcrumb {
        font-size: 0.85em;
        font-weight: 400;
        color: #6a737d;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .md-page-title + .md-page-breadcrumb {
        border-left: 1px solid #d1d5da;
        padding-left: 0.75em;
      }
    </style>`;

const LIGHTBOX_SNIPPET = `<style>
      .md-lightbox-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        cursor: zoom-out;
      }
      .md-lightbox-overlay img {
        max-width: 95vw;
        max-height: 95vh;
        object-fit: contain;
      }
      img { cursor: zoom-in; }
      .md-lightbox-overlay img { cursor: zoom-out; }
    </style>
    <script>
      document.addEventListener("click", function (e) {
        var img = e.target && e.target.closest ? e.target.closest("img") : null;
        if (!img || img.closest(".md-lightbox-overlay")) return;
        var link = img.closest("a");
        if (link) {
          var href = link.getAttribute("href") || "";
          var isImageHref =
            /\\.(png|jpe?g|gif|svg|webp|bmp|avif)([?#].*)?$/i.test(href) ||
            href.indexOf("data:image/") === 0;
          if (!isImageHref) return;
        }
        e.preventDefault();
        var overlay = document.createElement("div");
        overlay.className = "md-lightbox-overlay";
        var big = document.createElement("img");
        big.src = img.currentSrc || img.src;
        overlay.appendChild(big);
        overlay.addEventListener("click", function () { overlay.remove(); });
        document.addEventListener("keydown", function esc(ev) {
          if (ev.key === "Escape") {
            overlay.remove();
            document.removeEventListener("keydown", esc);
          }
        });
        document.body.appendChild(overlay);
      });
    </script>`;

function injectLightbox(html) {
  if (html.includes("md-lightbox-overlay")) {
    return html;
  }

  return html.replace("</body>", `  ${LIGHTBOX_SNIPPET}\n  </body>`);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function injectCustomCss(html) {
  if (html.includes(CUSTOM_CSS)) {
    return html;
  }

  return html.replace("</head>", `${CUSTOM_CSS}\n  </head>`);
}

/**
 * Mume's offline export can leave some of its own stylesheets (e.g. KaTeX)
 * as absolute file:// links into its local node_modules instead of inlining
 * them. Read those files and embed their contents directly so the HTML has
 * no dependency on the machine/project it was generated on.
 *
 * Scoped deliberately narrow: only the <head> (markdown body content never
 * ends up there) and only paths under node_modules (mume's own deps) are
 * eligible — this is not a general-purpose "inline any file:// link" pass,
 * since markdown content could itself contain a raw <link file://...> tag
 * (e.g. as a teaching example) and we must never read/embed arbitrary local
 * files on the machine running the conversion.
 */
async function inlineLocalStylesheets(html, log) {
  const headEnd = html.indexOf("</head>");
  if (headEnd === -1) {
    return html;
  }

  const head = html.slice(0, headEnd);
  const rest = html.slice(headEnd);
  const linkRegex = /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["'](file:\/+[^"']+)["'][^>]*>/gi;
  const matches = [...head.matchAll(linkRegex)];
  let newHead = head;

  for (const match of matches) {
    const tag = match[0];
    const fileUrl = match[1];
    let filePath;
    try {
      filePath = decodeURIComponent(fileUrl.replace(/^file:\/+/, "/"));
    } catch {
      continue;
    }

    if (!/[\\/]node_modules[\\/]/.test(filePath)) {
      continue;
    }

    try {
      const css = await fs.readFile(filePath, "utf8");
      newHead = newHead.replace(tag, `<style>\n${css}\n</style>`);
    } catch {
      log(`⚠ Could not inline stylesheet, removing broken link: ${filePath}`);
      newHead = newHead.replace(tag, "");
    }
  }

  return newHead + rest;
}

function forceBlankTargetOnExternalLinks(html) {
  return html.replace(
    /<a\b([^>]*\bhref=["']https?:\/\/[^"']+["'][^>]*)>/gi,
    (match, attrs) => {
      if (/\btarget=/i.test(attrs)) {
        return `<a${attrs}>`;
      }

      return `<a${attrs} target="_blank" rel="noopener noreferrer">`;
    },
  );
}

const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

const WARN_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Replace local <img> sources with base64 data URIs. Images larger than
 * 2 MB are inlined too, with a warning. Images that can't be read keep
 * their original src.
 */
async function inlineLocalImages(html, baseDirs, log) {
  const imgTagRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const srcs = [];
  let match;
  while ((match = imgTagRegex.exec(html)) !== null) {
    const src = match[1];
    if (!/^(https?:|data:|\/\/)/i.test(src) && !srcs.includes(src)) {
      srcs.push(src);
    }
  }

  const dataUris = new Map();

  for (const src of srcs) {
    let relPath;
    try {
      relPath = decodeURIComponent(src.split(/[?#]/)[0]);
    } catch {
      relPath = src.split(/[?#]/)[0];
    }

    const mime = IMAGE_MIME_TYPES[path.extname(relPath).toLowerCase()];
    if (!mime) {
      continue;
    }

    for (const baseDir of baseDirs) {
      const filePath = path.isAbsolute(relPath)
        ? relPath
        : path.join(baseDir, relPath);

      try {
        const data = await fs.readFile(filePath);
        if (data.length > WARN_IMAGE_BYTES) {
          log(
            `⚠ Large image inlined: ${src} (${(data.length / 1024 / 1024).toFixed(1)} MB) — consider compressing it`,
          );
        }
        dataUris.set(src, `data:${mime};base64,${data.toString("base64")}`);
        break;
      } catch {
        // Try the next base directory.
      }
    }
  }

  if (dataUris.size === 0) {
    return html;
  }

  return html.replace(imgTagRegex, (tag, src) => {
    const dataUri = dataUris.get(src);
    return dataUri ? tag.replace(src, dataUri) : tag;
  });
}

function injectHeaderFooter(html, header, footer, breadcrumb) {
  let result = html;

  if ((header || breadcrumb) && !result.includes('class="md-page-header"')) {
    const parts = [];
    if (header) {
      parts.push(`<span class="md-page-title">${header}</span>`);
    }
    if (breadcrumb) {
      parts.push(`<span class="md-page-breadcrumb">${breadcrumb}</span>`);
    }
    result = result.replace(
      /(<body[^>]*>)/i,
      `$1\n    <header class="md-page-header">${parts.join("")}</header>`,
    );
  }

  if (footer && !result.includes('class="md-page-footer"')) {
    result = result.replace(
      "</body>",
      `  <footer class="md-page-footer">${footer}</footer>\n  </body>`,
    );
  }

  return result;
}

const SKIPPED_NAMES = new Set([
  "node_modules",
  "package.json",
  "package-lock.json",
  "md-to-html.config.json",
  ".git",
  ".gitignore",
  ".DS_Store",
  ".claude",
  ".vscode",
  ".idea",
]);

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Recursively list all files under dir, skipping junk (node_modules, .git,
 * etc.) and the output directory. Hidden folders like `.img` are included —
 * they are commonly used for images referenced from markdown.
 */
async function listFiles(dir, outputDir, files = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIPPED_NAMES.has(entry.name)) {
      continue;
    }

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (containsPath(full, outputDir)) {
        continue;
      }
      await listFiles(full, outputDir, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  return files;
}

function cleanRef(ref) {
  if (/^(https?:|data:|mailto:|tel:|javascript:|#|\/\/)/i.test(ref) || path.isAbsolute(ref)) {
    return null;
  }

  let cleaned = ref.split(/[?#]/)[0];
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // keep as-is
  }
  return cleaned || null;
}

/**
 * Extract relative src/href references from HTML (skipping external URLs,
 * data URIs, anchors, and absolute paths).
 */
function collectLocalRefs(html) {
  const refs = [];
  const regex = /<(?:img|a|source|video|audio|embed|object)\b[^>]*\b(?:src|href|data)=["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned) {
      refs.push(cleaned);
    }
  }

  return refs;
}

/**
 * Hrefs of image links that wrap an <img> — the lightbox handles these in
 * the browser, so the linked image file isn't needed in the output.
 */
function collectLightboxHandledHrefs(html) {
  const hrefs = new Set();
  // breakOnSingleNewLine can insert <br> between the anchor and the image.
  const regex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(?:\s|<br\s*\/?>)*<img\b/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const cleaned = cleanRef(match[1]);
    if (cleaned && IMAGE_MIME_TYPES[path.extname(cleaned).toLowerCase()]) {
      hrefs.add(cleaned);
    }
  }

  return hrefs;
}

/**
 * Convert all .md files in options.input to standalone .html files in options.output.
 *
 * @param {object} options
 * @param {string} options.input - Directory containing .md files.
 * @param {string} options.output - Directory to write .html files to (created if missing).
 * @param {string} [options.header] - HTML/text rendered as a page header on every page.
 * @param {string} [options.footer] - HTML/text rendered as a page footer on every page.
 * Local images are always embedded as base64 data URIs (a warning is logged
 * for images larger than 2 MB) and the input folder structure is mirrored
 * in the output directory.
 *
 * @param {boolean} [options.assets=true] - Copy files referenced by the generated HTML
 *   (linked PDFs etc.) to the output directory. Unreferenced files are never copied.
 * @param {boolean} [options.clean=true] - Empty the output directory before converting.
 * @param {boolean} [options.lightbox=true] - Open image links (click-to-enlarge) in a
 *   fullscreen overlay instead of navigating to the image file.
 * @param {boolean} [options.quiet=false] - Suppress progress logging.
 * @returns {Promise<{converted: string[], failed: {file: string, error: string}[]}>}
 */
async function convert(options) {
  const {
    input,
    output,
    header,
    footer,
    assets = true,
    clean = true,
    lightbox = true,
    quiet = false,
  } = options;

  if (!input || !output) {
    throw new Error("Both 'input' and 'output' directories are required");
  }

  const log = quiet ? () => {} : (...args) => console.log(...args);

  const inputDir = path.resolve(input);
  const outputDir = path.resolve(output);

  try {
    await fs.access(inputDir);
  } catch {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  if (clean && (await fileExists(outputDir))) {
    const root = path.parse(outputDir).root;
    if (
      outputDir === root ||
      outputDir === os.homedir() ||
      containsPath(outputDir, inputDir)
    ) {
      throw new Error(
        `Refusing to clean output directory ${outputDir} (it is a root/home directory or contains the input directory)`,
      );
    }
    await fs.rm(outputDir, { recursive: true, force: true });
    log(`Cleaned output directory: ${outputDir}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  // mume needs its config directory (~/.mume) to exist.
  await mume.init();

  const allFiles = (await listFiles(inputDir, outputDir)).sort();
  const markdownFiles = allFiles.filter((file) => /\.md$/i.test(file));

  if (markdownFiles.length === 0) {
    log(`No markdown files found in ${inputDir}`);
    return { converted: [], failed: [] };
  }

  log(`Found ${markdownFiles.length} markdown file(s) to convert`);

  const converted = [];
  const failed = [];
  const referencedAssets = new Map(); // dest path -> source path

  for (const mdFile of markdownFiles) {
    const baseName = path.basename(mdFile, path.extname(mdFile));
    const relDir = path.relative(inputDir, path.dirname(mdFile));
    const outputPath = path.join(outputDir, relDir, `${baseName}.html`);

    try {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const engine = new MarkdownEngine({
        filePath: mdFile,
        config: DEFAULT_ENGINE_CONFIG,
      });

      await engine.htmlExport({ offline: true, outputFilePath: outputPath });

      // Mume may ignore outputFilePath and write next to the source file.
      const fallbackPath = path.join(path.dirname(mdFile), `${baseName}.html`);
      if (!(await fileExists(outputPath)) && (await fileExists(fallbackPath))) {
        await fs.rename(fallbackPath, outputPath);
      }

      if (!(await fileExists(outputPath))) {
        throw new Error("No HTML output was produced");
      }

      const breadcrumb = relDir
        .split(path.sep)
        .filter(Boolean)
        .join(" - ");

      const html = await fs.readFile(outputPath, "utf8");
      let updatedHtml = injectHeaderFooter(
        injectCustomCss(forceBlankTargetOnExternalLinks(await inlineLocalStylesheets(html, log))),
        header,
        footer,
        breadcrumb,
      );
      if (lightbox) {
        updatedHtml = injectLightbox(updatedHtml);
      }
      updatedHtml = await inlineLocalImages(
        updatedHtml,
        [path.dirname(mdFile), path.dirname(outputPath)],
        log,
      );
      if (updatedHtml !== html) {
        await fs.writeFile(outputPath, updatedHtml, "utf8");
      }

      if (assets) {
        const handledByLightbox = lightbox
          ? collectLightboxHandledHrefs(updatedHtml)
          : new Set();
        for (const ref of collectLocalRefs(updatedHtml)) {
          if (/\.(md|html)$/i.test(ref) || handledByLightbox.has(ref)) {
            continue;
          }
          const src = path.resolve(path.dirname(mdFile), ref);
          const dest = path.resolve(path.dirname(outputPath), ref);
          // Only copy files that live inside input and land inside output.
          if (containsPath(inputDir, src) && containsPath(outputDir, dest)) {
            referencedAssets.set(dest, src);
          }
        }
      }

      converted.push(outputPath);
      log(
        `✓ Converted: ${path.relative(inputDir, mdFile)} -> ${path.relative(outputDir, outputPath)}`,
      );
    } catch (error) {
      failed.push({ file: mdFile, error: error.message });
      console.error(`✗ Failed to convert ${path.relative(inputDir, mdFile)}: ${error.message}`);
    }
  }

  for (const [dest, src] of referencedAssets) {
    try {
      const stat = await fs.stat(src);
      if (!stat.isFile()) {
        continue;
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(src, dest, { force: true });
      log(`Copied asset: ${path.relative(outputDir, dest)}`);
    } catch {
      log(`⚠ Referenced file not found, skipped: ${path.relative(inputDir, src)}`);
    }
  }

  return { converted, failed };
}

module.exports = {
  convert,
  injectCustomCss,
  forceBlankTargetOnExternalLinks,
  injectHeaderFooter,
  injectLightbox,
  inlineLocalImages,
  inlineLocalStylesheets,
};
