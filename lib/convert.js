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
        font-size: 1.1em;
        font-weight: 600;
        border-bottom: 1px solid #eaecef;
      }
      .md-page-footer {
        font-size: 0.85em;
        color: #6a737d;
        border-top: 1px solid #eaecef;
      }
      .md-page-breadcrumb {
        display: block;
        font-size: 0.8em;
        font-weight: 400;
        color: #6a737d;
        margin-top: 2px;
      }
    </style>`;

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

/**
 * Replace local <img> sources with base64 data URIs, up to maxBytes of
 * image file bytes per HTML file. Images that would exceed the budget
 * (or can't be read) keep their original src.
 */
async function inlineLocalImages(html, baseDirs, maxBytes, log) {
  const imgTagRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const srcs = [];
  let match;
  while ((match = imgTagRegex.exec(html)) !== null) {
    const src = match[1];
    if (!/^(https?:|data:|\/\/)/i.test(src) && !srcs.includes(src)) {
      srcs.push(src);
    }
  }

  let budget = maxBytes;
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
        const stat = await fs.stat(filePath);
        if (stat.size > budget) {
          log(
            `⚠ Skipped inlining ${src} (${(stat.size / 1024 / 1024).toFixed(1)} MB exceeds remaining image budget)`,
          );
          break;
        }

        const data = await fs.readFile(filePath);
        budget -= data.length;
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
    const breadcrumbHtml = breadcrumb
      ? `<span class="md-page-breadcrumb">${breadcrumb}</span>`
      : "";
    result = result.replace(
      /(<body[^>]*>)/i,
      `$1\n    <header class="md-page-header">${header || ""}${breadcrumbHtml}</header>`,
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

/**
 * Extract relative src/href references from HTML (skipping external URLs,
 * data URIs, anchors, and absolute paths).
 */
function collectLocalRefs(html) {
  const refs = [];
  const regex = /<(?:img|a|source|video|audio|embed|object)\b[^>]*\b(?:src|href|data)=["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const ref = match[1];
    if (/^(https?:|data:|mailto:|tel:|javascript:|#|\/\/)/i.test(ref) || path.isAbsolute(ref)) {
      continue;
    }

    let cleaned = ref.split(/[?#]/)[0];
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // keep as-is
    }
    if (cleaned) {
      refs.push(cleaned);
    }
  }

  return refs;
}

/**
 * Convert all .md files in options.input to standalone .html files in options.output.
 *
 * @param {object} options
 * @param {string} options.input - Directory containing .md files.
 * @param {string} options.output - Directory to write .html files to (created if missing).
 * @param {string} [options.header] - HTML/text rendered as a page header on every page.
 * @param {string} [options.footer] - HTML/text rendered as a page footer on every page.
 * @param {boolean} [options.flat=false] - Write all .html files directly into output, without
 *   mirroring the input folder structure. Combine with inlineImages so image links keep working.
 * @param {boolean} [options.assets=true] - Copy files referenced by the generated HTML
 *   (images etc.) to the output directory. Unreferenced files are never copied.
 * @param {boolean} [options.clean=true] - Empty the output directory before converting.
 * @param {boolean} [options.inlineImages=false] - Embed local images as base64 data URIs.
 * @param {number} [options.inlineImagesMaxMB=10] - Max MB of image file bytes to inline per HTML file.
 * @param {boolean} [options.quiet=false] - Suppress progress logging.
 * @returns {Promise<{converted: string[], failed: {file: string, error: string}[]}>}
 */
async function convert(options) {
  const {
    input,
    output,
    header,
    footer,
    flat = false,
    assets = true,
    clean = true,
    inlineImages = false,
    inlineImagesMaxMB = 10,
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
  const usedOutputPaths = new Set();
  const referencedAssets = new Map(); // dest path -> source path

  for (const mdFile of markdownFiles) {
    const baseName = path.basename(mdFile, path.extname(mdFile));
    const relDir = path.relative(inputDir, path.dirname(mdFile));

    let outputPath = flat
      ? path.join(outputDir, `${baseName}.html`)
      : path.join(outputDir, relDir, `${baseName}.html`);

    // In flat mode, files from different folders can share a name — fall
    // back to a name derived from the relative path.
    if (flat && usedOutputPaths.has(outputPath)) {
      const flatName = path
        .join(relDir, baseName)
        .split(path.sep)
        .filter(Boolean)
        .join("-");
      log(`⚠ Name collision for ${baseName}.html, writing ${flatName}.html instead`);
      outputPath = path.join(outputDir, `${flatName}.html`);
    }
    usedOutputPaths.add(outputPath);

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
        injectCustomCss(forceBlankTargetOnExternalLinks(html)),
        header,
        footer,
        breadcrumb,
      );
      if (inlineImages) {
        updatedHtml = await inlineLocalImages(
          updatedHtml,
          [path.dirname(mdFile), path.dirname(outputPath)],
          inlineImagesMaxMB * 1024 * 1024,
          log,
        );
      }
      if (updatedHtml !== html) {
        await fs.writeFile(outputPath, updatedHtml, "utf8");
      }

      if (assets) {
        for (const ref of collectLocalRefs(updatedHtml)) {
          if (/\.(md|html)$/i.test(ref)) {
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
  inlineLocalImages,
};
