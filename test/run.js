const assert = require("assert");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { convert, inlineLocalStylesheets } = require("../lib/convert");

// 1x1 red pixel PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMAAZ3H9h8AAAAASUVORK5CYII=",
  "base64",
);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "md-to-html-test-"));
  const input = path.join(tmp, "docs");
  const output = path.join(tmp, "out");

  await fs.mkdir(path.join(input, "images"), { recursive: true });
  await fs.mkdir(path.join(input, "Day 1", "Exercises"), { recursive: true });
  await fs.mkdir(path.join(input, "Day 1", ".img"), { recursive: true });
  await fs.writeFile(path.join(input, "images", "dot.png"), PNG);
  await fs.writeFile(path.join(input, "images", "unused.png"), PNG);
  await fs.writeFile(path.join(input, "Day 1", ".img", "dot.png"), PNG);
  await fs.writeFile(path.join(input, "notes.txt"), "not referenced anywhere");
  await fs.writeFile(path.join(input, "handout.pdf"), "%PDF-1.4 fake");
  await fs.writeFile(
    path.join(input, "page.md"),
    "# Title\n\n## Section\n\n[ext](https://example.com)\n\n" +
      "[![dot](images/dot.png)](images/dot.png)\n\n[Handout](handout.pdf)\n",
  );
  await fs.writeFile(
    path.join(input, "Day 1", "Exercises", "task.md"),
    "# Task\n\n![dot](../.img/dot.png)\n",
  );

  const { converted, failed } = await convert({
    input,
    output,
    header: "Test Header",
    footer: "Test Footer",
    quiet: true,
  });

  assert.strictEqual(failed.length, 0, "no conversions should fail");
  assert.strictEqual(converted.length, 2, "two files should be converted");

  const html = await fs.readFile(path.join(output, "page.html"), "utf8");
  assert.ok(html.includes('class="md-page-title">Test Header<'), "header injected");
  assert.ok(html.includes('class="md-page-footer">Test Footer<'), "footer injected");
  assert.ok(
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer"/.test(html),
    "external links open in new tab",
  );
  assert.ok(html.includes('src="data:image/png;base64,'), "images always inlined");
  assert.ok(html.includes("md-lightbox-overlay"), "lightbox injected");

  const nestedHtml = await fs.readFile(
    path.join(output, "Day 1", "Exercises", "task.html"),
    "utf8",
  );
  assert.ok(
    nestedHtml.includes('class="md-page-breadcrumb">Day 1 - Exercises<'),
    "breadcrumb shows source folder path",
  );
  assert.ok(
    nestedHtml.includes('src="data:image/png;base64,'),
    "nested ../.img image inlined",
  );
  assert.ok(
    nestedHtml.includes("img { cursor: zoom-in; }"),
    "bare (non-linked) images are also click-to-enlarge",
  );
  assert.ok(
    nestedHtml.includes('img.closest("a")'),
    "lightbox click handler looks up from the img, not from an anchor wrapper",
  );

  assert.ok(await exists(path.join(output, "handout.pdf")), "referenced non-image file copied");
  assert.ok(
    !(await exists(path.join(output, "images", "dot.png"))),
    "image link target not copied (inlined + lightbox)",
  );
  assert.ok(!(await exists(path.join(output, "images", "unused.png"))), "unused image not copied");
  assert.ok(!(await exists(path.join(output, "Day 1", ".img"))), "inlined .img folder not copied");
  assert.ok(!(await exists(path.join(output, "notes.txt"))), "unreferenced file not copied");
  assert.ok(!(await exists(path.join(output, "page.md"))), "no md files in output");

  // --- Clean: stale files are removed on the next run ---
  await fs.writeFile(path.join(output, "stale.html"), "old");
  await convert({ input, output, quiet: true });
  assert.ok(!(await exists(path.join(output, "stale.html"))), "stale file removed by clean");

  // --- Clean guard: output containing input must be refused ---
  await assert.rejects(
    convert({ input, output: tmp, quiet: true }),
    /Refusing to clean/,
    "cleaning a directory that contains the input is refused",
  );

  // --- Output inside input: allowed, does not recurse into itself ---
  const innerOut = path.join(input, "html");
  const innerResult = await convert({ input, output: innerOut, quiet: true });
  assert.strictEqual(innerResult.failed.length, 0, "inner output: no conversions should fail");
  assert.ok(
    await exists(path.join(innerOut, "Day 1", "Exercises", "task.html")),
    "inner output: structure mirrored",
  );

  // --- Lightbox can be disabled; image link targets are then copied ---
  const noLightbox = await convert({ input, output, lightbox: false, quiet: true });
  assert.strictEqual(noLightbox.failed.length, 0, "no-lightbox: no conversions should fail");
  const plainHtml = await fs.readFile(path.join(output, "page.html"), "utf8");
  assert.ok(!plainHtml.includes("md-lightbox-overlay"), "lightbox can be disabled");
  assert.ok(
    await exists(path.join(output, "images", "dot.png")),
    "no-lightbox: image link target copied so links keep working",
  );

  // --- Stylesheet inlining: only mume's own node_modules css links are touched ---
  const cssDir = path.join(tmp, "node_modules", "@shd101wyy", "mume", "katex");
  await fs.mkdir(cssDir, { recursive: true });
  const cssFile = path.join(cssDir, "katex.min.css");
  await fs.writeFile(cssFile, ".katex { color: red; }");
  const htmlWithFileLink = `<html><head><link rel="stylesheet" href="file:///${cssFile.replace(/^\//, "")}"></head><body></body></html>`;
  const inlined = await inlineLocalStylesheets(htmlWithFileLink, () => {});
  assert.ok(!inlined.includes("file://"), "node_modules file:// stylesheet link removed");
  assert.ok(inlined.includes(".katex { color: red; }"), "stylesheet content inlined");

  const htmlWithMissingFile = `<html><head><link rel="stylesheet" href="file:////nonexistent/node_modules/path.css"></head><body></body></html>`;
  const cleaned = await inlineLocalStylesheets(htmlWithMissingFile, () => {});
  assert.ok(!cleaned.includes("file://"), "broken node_modules file:// stylesheet link removed rather than left dangling");

  // --- Safety: a file:// link outside node_modules, or in the body, must never be read ---
  const secretFile = path.join(tmp, "secret.txt");
  await fs.writeFile(secretFile, "TOP SECRET CONTENTS");
  const htmlWithOutsideLink = `<html><head><link rel="stylesheet" href="file://${secretFile}"></head><body></body></html>`;
  const untouchedHead = await inlineLocalStylesheets(htmlWithOutsideLink, () => {});
  assert.ok(
    untouchedHead.includes("file://") && !untouchedHead.includes("TOP SECRET"),
    "non-node_modules file:// link in <head> is left untouched, never read",
  );

  const htmlWithBodyLink = `<html><head></head><body><p>Example: &lt;link rel="stylesheet" href="file://${secretFile}"&gt;</p><link rel="stylesheet" href="file://${secretFile}"></body></html>`;
  const untouchedBody = await inlineLocalStylesheets(htmlWithBodyLink, () => {});
  assert.ok(
    !untouchedBody.includes("TOP SECRET"),
    "a file:// link appearing in the body (e.g. markdown teaching example) is never read",
  );

  await fs.rm(tmp, { recursive: true, force: true });
  console.log("✓ all tests passed");
  process.exit(0);
}

main().catch((error) => {
  console.error("✗ test failed:", error.message);
  process.exit(1);
});
