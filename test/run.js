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

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "md-to-html-test-"));
  const input = path.join(tmp, "docs");
  const output = path.join(tmp, "out");

  await fs.mkdir(path.join(input, "images"), { recursive: true });
  await fs.mkdir(path.join(input, "Day 1", "Exercises"), { recursive: true });
  await fs.mkdir(path.join(input, "Day 1", ".img"), { recursive: true });
  await fs.writeFile(path.join(input, "images", "dot.png"), PNG);
  await fs.writeFile(path.join(input, "Day 1", ".img", "dot.png"), PNG);
  await fs.writeFile(
    path.join(input, "page.md"),
    "# Title\n\n## Section\n\n[ext](https://example.com)\n\n![dot](images/dot.png)\n",
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
    inlineImages: true,
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
  assert.ok(html.includes('src="data:image/png;base64,'), "image inlined as data URI");
  assert.ok(
    (await fs.stat(path.join(output, "images", "dot.png"))).isFile(),
    "assets copied to output",
  );

  const nestedHtml = await fs.readFile(
    path.join(output, "Day 1", "Exercises", "task.html"),
    "utf8",
  );
  assert.ok(
    nestedHtml.includes('class="md-page-breadcrumb">Day 1 - Exercises<'),
    "breadcrumb shows source folder path",
  );
  assert.ok(nestedHtml.includes('src="data:image/png;base64,'), "nested ../.img image inlined");
  assert.ok(
    (await fs.stat(path.join(output, "Day 1", ".img", "dot.png"))).isFile(),
    "hidden .img asset folder copied",
  );

  // Flat mode: no subfolders, output inside input must not recurse into itself.
  const flatOut = path.join(input, "html");
  const flatResult = await convert({ input, output: flatOut, flat: true, quiet: true });
  assert.strictEqual(flatResult.failed.length, 0, "flat: no conversions should fail");
  assert.ok(
    (await fs.stat(path.join(flatOut, "task.html"))).isFile(),
    "flat: nested file lands in output root",
  );

  await fs.rm(tmp, { recursive: true, force: true });
  console.log("✓ all tests passed");
  process.exit(0);
}

main().catch((error) => {
  console.error("✗ test failed:", error.message);
  process.exit(1);
});
