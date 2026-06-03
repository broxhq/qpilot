#!/usr/bin/env node
"use strict";

const { cpSync, existsSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error("standalone dir not found — skipping copy");
  process.exit(0);
}

cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), {
  recursive: true,
});

const pub = join(root, "public");
if (existsSync(pub)) {
  cpSync(pub, join(standalone, "public"), { recursive: true });
}

console.log("✓ static files copied to standalone");
