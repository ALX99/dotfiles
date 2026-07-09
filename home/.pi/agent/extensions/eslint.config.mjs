// @ts-check
import { createRequire } from "node:module";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";

// typescript-eslint does not support TypeScript 7 yet. Keep the compiler on
// TypeScript 7, but give the ESLint parser its supported compiler runtime.
const require = createRequire(import.meta.url);
const moduleApi = require("node:module");
const legacyTypescript = require.resolve("typescript-legacy");
const resolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request, ...args) {
  return request === "typescript"
    ? legacyTypescript
    : resolveFilename.call(this, request, ...args);
};
const tseslint = require("typescript-eslint");
moduleApi._resolveFilename = resolveFilename;

export default defineConfig({
  files: ["**/*.ts"],
  extends: [js.configs.recommended, tseslint.configs.recommended],
  languageOptions: {
    parser: tseslint.parser,
  },
  rules: {
    // typescript-eslint's no-unused-vars drops the base rule's `_` prefix
    // convention by default. Restore it so `_context`, `_unused`, etc. work.
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        args: "all",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
  },
});
