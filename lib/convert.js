const fs = require("fs").promises;
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

function injectHeaderFooter(html, header, footer) {
  let result = html;

  if (header && !result.includes('class="md-page-header"')) {
    result = result.replace(
      /(<body[^>]*>)/i,
      `$1\n    <header class="md-page-header">${header}</header>`,
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

async function copyAssets(inputDir, outputDir, log) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && /\.(md|html)$/i.test(entry.name)) {
      continue;
    }

    const src = path.join(inputDir, entry.name);
    const dest = path.join(outputDir, entry.name);
    await fs.cp(src, dest, { recursive: true, force: true });
    log(`Copied asset: ${entry.name}`);
  }
}

/**
 * Convert all .md files in options.input to standalone .html files in options.output.
 *
 * @param {object} options
 * @param {string} options.input - Directory containing .md files.
 * @param {string} options.output - Directory to write .html files to (created if missing).
 * @param {string} [options.header] - HTML/text rendered as a page header on every page.
 * @param {string} [options.footer] - HTML/text rendered as a page footer on every page.
 * @param {boolean} [options.assets=true] - Copy non-markdown files/folders (e.g. images) to output.
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
    assets = true,
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

  await fs.mkdir(outputDir, { recursive: true });

  // mume needs its config directory (~/.mume) to exist.
  await mume.init();

  const entries = await fs.readdir(inputDir);
  const markdownFiles = entries
    .filter((name) => /\.md$/i.test(name))
    .sort()
    .map((name) => path.join(inputDir, name));

  if (markdownFiles.length === 0) {
    log(`No markdown files found in ${inputDir}`);
    return { converted: [], failed: [] };
  }

  log(`Found ${markdownFiles.length} markdown file(s) to convert`);

  const converted = [];
  const failed = [];

  for (const mdFile of markdownFiles) {
    const baseName = path.basename(mdFile, path.extname(mdFile));
    const outputPath = path.join(outputDir, `${baseName}.html`);

    try {
      const engine = new MarkdownEngine({
        filePath: mdFile,
        config: DEFAULT_ENGINE_CONFIG,
      });

      await engine.htmlExport({ offline: true, outputFilePath: outputPath });

      // Mume may ignore outputFilePath and write next to the source file.
      const fallbackPath = path.join(inputDir, `${baseName}.html`);
      if (!(await fileExists(outputPath)) && (await fileExists(fallbackPath))) {
        await fs.rename(fallbackPath, outputPath);
      }

      if (!(await fileExists(outputPath))) {
        throw new Error("No HTML output was produced");
      }

      const html = await fs.readFile(outputPath, "utf8");
      let updatedHtml = injectHeaderFooter(
        injectCustomCss(forceBlankTargetOnExternalLinks(html)),
        header,
        footer,
      );
      if (inlineImages) {
        updatedHtml = await inlineLocalImages(
          updatedHtml,
          [inputDir, outputDir],
          inlineImagesMaxMB * 1024 * 1024,
          log,
        );
      }
      if (updatedHtml !== html) {
        await fs.writeFile(outputPath, updatedHtml, "utf8");
      }

      converted.push(outputPath);
      log(`✓ Converted: ${path.basename(mdFile)} -> ${baseName}.html`);
    } catch (error) {
      failed.push({ file: mdFile, error: error.message });
      console.error(`✗ Failed to convert ${path.basename(mdFile)}: ${error.message}`);
    }
  }

  if (assets) {
    await copyAssets(inputDir, outputDir, log);
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
