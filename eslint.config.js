import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["build/", "node_modules/", "addon/content/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["addon/**/*.js"],
    languageOptions: { sourceType: "script", globals: { Services: "readonly", Zotero: "readonly", pref: "readonly", Cc: "readonly", Ci: "readonly" } },
    // startup/shutdown/install/uninstall are called by Zotero, not from this file.
    rules: { "no-unused-vars": "off", "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    files: ["addon/static/**/*.js"],
    languageOptions: { sourceType: "script", globals: { Zotero: "readonly", document: "readonly", window: "readonly" } },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", URL: "readonly" } },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
);
