import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // plain Node scripts: CommonJS on purpose, they run before anything is built
    files: ["bin/**", "scripts/**"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // a leading underscore marks a value taken only to drop it: `const { events: _events, ...rest } = run`
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];

export default config;
