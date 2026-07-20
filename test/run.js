const assert = require("assert");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { convert } = require("../lib/convert");

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
  await fs.writeFile(
    path.join(input, "page.md"),
    "# Title\n\n## Section\n\n[ext](https://example.com)\n\n[![dot](images/dot.png)](images/dot.png)\n",
  );
  await fs.writeFile(
    path.join(input, "Day 1", "Exercises", "task.md"),
    "# Task\n\n![dot](../.img/dot.png)\n",
  );

  // --- Mirrored mode, no inlining: referenced assets copied, junk excluded ---
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
  assert.ok(html.includes('class="md-page-header">Test Header<'), "header injected");
  assert.ok(html.includes('class="md-page-footer">Test Footer<'), "footer injected");
  assert.ok(
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer"/.test(html),
    "external links open in new tab",
  );

  const nestedHtml = await fs.readFile(
    path.join(output, "Day 1", "Exercises", "task.html"),
    "utf8",
  );
  assert.ok(
    nestedHtml.includes('class="md-page-breadcrumb">Day 1 - Exercises<'),
    "breadcrumb shows source folder path",
  );

  assert.ok(await exists(path.join(output, "images", "dot.png")), "referenced asset copied");
  assert.ok(
    await exists(path.join(output, "Day 1", ".img", "dot.png")),
    "referenced hidden .img asset copied",
  );
  assert.ok(!(await exists(path.join(output, "images", "unused.png"))), "unused image not copied");
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

  // --- Flat + inline: single folder, images embedded, none copied ---
  const flatOut = path.join(input, "html");
  const flatResult = await convert({
    input,
    output: flatOut,
    flat: true,
    inlineImages: true,
    quiet: true,
  });
  assert.strictEqual(flatResult.failed.length, 0, "flat: no conversions should fail");
  const flatHtml = await fs.readFile(path.join(flatOut, "task.html"), "utf8");
  assert.ok(flatHtml.includes('src="data:image/png;base64,'), "flat: image inlined as data URI");
  assert.ok(!(await exists(path.join(flatOut, "images"))), "flat+inline: no image files copied");

  const flatPageHtml = await fs.readFile(path.join(flatOut, "page.html"), "utf8");
  assert.ok(
    flatPageHtml.includes("md-lightbox-overlay"),
    "lightbox injected for click-to-enlarge image links",
  );
  const noLightbox = await convert({
    input,
    output: flatOut,
    flat: true,
    lightbox: false,
    quiet: true,
  });
  assert.strictEqual(noLightbox.failed.length, 0, "no-lightbox: no conversions should fail");
  assert.ok(
    !(await fs.readFile(path.join(flatOut, "page.html"), "utf8")).includes("md-lightbox-overlay"),
    "lightbox can be disabled",
  );

  await fs.rm(tmp, { recursive: true, force: true });
  console.log("✓ all tests passed");
  process.exit(0);
}

main().catch((error) => {
  console.error("✗ test failed:", error.message);
  process.exit(1);
});
