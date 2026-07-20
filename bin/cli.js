#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { convert } = require("../lib/convert");

const DEFAULT_CONFIG_FILE = "md-to-html.config.json";

const HELP = `md-to-html — convert a folder of Markdown files to standalone HTML files

Usage:
  md-to-html --input <dir> --output <dir> [options]

Options:
  -i, --input <dir>     Directory containing .md files (required)
  -o, --output <dir>    Directory to write .html files to (required)
      --header <text>   Header text/HTML shown at the top of every page
      --footer <text>   Footer text/HTML shown at the bottom of every page
      --no-assets       Do not copy referenced files (e.g. linked PDFs) to output
      --no-clean        Do not empty the output directory before converting
      --no-lightbox     Do not open image links in a fullscreen overlay
  -c, --config <file>   Config file (default: ./${DEFAULT_CONFIG_FILE} if present)
  -q, --quiet           Only print errors
  -h, --help            Show this help
  -v, --version         Show version

Config file (JSON, CLI flags take precedence):
  { "input": "./docs", "output": "../script", "header": "My Project", "footer": "© My Project" }
`;

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i++;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    switch (arg) {
      case "-i":
      case "--input":
        args.input = next();
        break;
      case "-o":
      case "--output":
        args.output = next();
        break;
      case "--header":
        args.header = next();
        break;
      case "--footer":
        args.footer = next();
        break;
      case "--no-assets":
        args.assets = false;
        break;
      case "--no-clean":
        args.clean = false;
        break;
      case "--no-lightbox":
        args.lightbox = false;
        break;
      case "-c":
      case "--config":
        args.config = next();
        break;
      case "-q":
      case "--quiet":
        args.quiet = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function loadConfig(configPath) {
  const resolved = path.resolve(configPath || DEFAULT_CONFIG_FILE);

  if (!fs.existsSync(resolved)) {
    if (configPath) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return {};
  }

  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  // Paths in the config file are relative to the config file's location.
  const baseDir = path.dirname(resolved);
  if (config.input) config.input = path.resolve(baseDir, config.input);
  if (config.output) config.output = path.resolve(baseDir, config.output);
  return config;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(`Run "md-to-html --help" for usage.`);
    process.exit(1);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  if (args.version) {
    console.log(require("../package.json").version);
    return;
  }

  let options;
  try {
    options = { ...loadConfig(args.config), ...args };
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (!options.input || !options.output) {
    console.error("Error: --input and --output are required (via flags or config file).\n");
    console.error(HELP);
    process.exit(1);
  }

  try {
    const { converted, failed } = await convert(options);

    if (failed.length > 0) {
      console.error(`\nDone with errors: ${converted.length} converted, ${failed.length} failed.`);
      process.exit(1);
    }

    if (!options.quiet) {
      console.log(`\n🎉 Converted ${converted.length} file(s) successfully!`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
