// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

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
