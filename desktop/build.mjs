// Packs qpilot as an app for the machine this runs on: a .dmg on macOS, an
// installer on Windows.
//
//   npm run build                 in the repository root: the server the app carries
//   npm --prefix desktop ci
//   npm --prefix desktop run dist → desktop/dist/
//
// The app is the frame (main.cjs) plus the built server, copied in whole next to
// it. The server has native parts (sharp), so an app is built on the system it
// is for; .github/workflows/desktop.yml does that for each one.
//
// Signing: with a certificate in the environment (CSC_LINK / CSC_KEY_PASSWORD,
// and APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to notarize)
// electron-builder signs by itself. Without one the macOS app gets an ad-hoc
// signature — Apple silicon runs nothing unsigned — and both systems warn on
// the first launch.

import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import builder from "electron-builder";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const standalone = join(root, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) throw new Error("Build the server first: npm run build (in the repository root)");

// the app carries the version of the package it was built from
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

await builder.build({
  projectDir: here,
  publish: "never",
  config: {
    appId: "sh.brox.qpilot",
    productName: "qpilot",
    copyright: "MIT License",
    extraMetadata: { version },
    directories: { output: "dist", buildResources: "build" },
    files: ["main.cjs", "package.json"],
    artifactName: "qpilot-${version}-${os}-${arch}.${ext}",
    // The server goes in as it is, node_modules and all: electron-builder's own
    // copying of resources drops folders named node_modules.
    afterPack: ({ appOutDir, electronPlatformName, packager }) => {
      const resources =
        electronPlatformName === "darwin"
          ? join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
          : join(appOutDir, "resources");
      cpSync(standalone, join(resources, "server"), { recursive: true, dereference: true });
    },
    mac: {
      category: "public.app-category.developer-tools",
      target: ["dmg"],
      // ad-hoc: the hardened runtime would refuse the app's own unsigned libraries
      ...(signed ? {} : { identity: "-", hardenedRuntime: false }),
    },
    win: { target: ["nsis"] },
    // for one user, into their own folder: no administrator rights asked
    nsis: { oneClick: true, perMachine: false },
  },
});
