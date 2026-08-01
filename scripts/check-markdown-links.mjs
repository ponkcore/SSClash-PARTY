#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
  encoding: "utf8",
});
const files = tracked.split("\0").filter(Boolean);
const missing = [];

for (const file of files) {
  const markdown = readFileSync(file, "utf8");

  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, "");

    if (
      !target ||
      target.startsWith("#") ||
      target.startsWith("/") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue;
    }

    target = target.split("#", 1)[0];
    if (!target) {
      continue;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      missing.push(`${file}: invalid URL encoding in ${match[1]}`);
      continue;
    }

    if (!existsSync(resolve(dirname(file), decoded))) {
      missing.push(`${file}: ${match[1]}`);
    }
  }
}

if (missing.length > 0) {
  process.stderr.write(`${missing.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Checked local Markdown links in ${files.length} files.\n`);
