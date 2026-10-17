# Setting up a portable package (engine/, client/, keys/ ...)

Root `package.json`: npm workspaces, `"engines": { "node": ">=22.18.0 <23" }`, and
`lint`/`typecheck`/`test` scripts that run across the workspaces with `--if-present`.

Each portable package:

```json
{
  "name": "@<app>/<pkg>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "engines": { "node": ">=22.18.0 <23" },
  "scripts": {
    "lint": "eslint",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json",
    "test": "node --test --test-reporter=spec \"test/**/*.test.ts\""
  }
}
```

`tsconfig.base.json` (Node runs the `.ts` directly, so only erasable syntax):

```json
{ "compilerOptions": {
  "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true,
  "noUncheckedIndexedAccess": true, "noImplicitOverride": true, "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true, "noUnusedLocals": true, "noUnusedParameters": true,
  "verbatimModuleSyntax": true, "erasableSyntaxOnly": true, "allowImportingTsExtensions": true,
  "isolatedModules": true, "resolveJsonModule": true, "skipLibCheck": true, "noEmit": true } }
```

`tsconfig.json`: `"lib": ["ES2022"], "types": []`, include `src` (no DOM, no Node types: the
compiler itself refuses platform APIs). `tsconfig.test.json`: `"types": ["node"]`, include
`src` and `test`. Imports use `.ts` extensions.

`eslint.config.mjs`:

```js
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// <why this package must stay portable, in one sentence>
const PORTABLE_CORE = {
  files: ["src/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", { patterns: [{ group: ["node:*"], message: "<pkg>/src is platform-neutral." }] }],
    "no-restricted-properties": ["error",
      { object: "Math", property: "random", message: "Randomness comes in as an argument." },
      { object: "Date", property: "now", message: "Pass time in; <pkg>/src has no clock." }],
    "no-restricted-globals": ["error",
      { name: "process", message: "<pkg>/src is platform-neutral." },
      { name: "fetch", message: "<pkg>/src does no I/O. The caller fetches." },
      { name: "window", message: "<pkg>/src is platform-neutral." }],
      // client/ also bans document, localStorage, indexedDB, crypto, setTimeout,
      // clearTimeout, setInterval and WebSocket ("Use platform.<x>").
  },
};

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.strict,
  PORTABLE_CORE,
  // noUncheckedIndexedAccess makes every index read optional; where it is known to be in range, `!` says so.
  { rules: { "@typescript-eslint/no-non-null-assertion": "off" } },
  globalIgnores(["node_modules/**"]),
]);
```

Schemas: zod (v4) in the engine is fine (it runs everywhere, and `z.toJSONSchema` gives MCP and
CLI descriptions). Cryptography: only `@noble/curves`, `@noble/ciphers`, `@noble/hashes` (and
CryptoKit on Apple's side), composed by us and checked against published test vectors.

CI (`.github/workflows/ci.yml`): one `check` job on `[self-hosted, <label>, <size>]`, skipped for
drafts, running `npm ci`, lint, typecheck, test (and the web build). Copy
`.github/workflows/review-decision.yml` from a reference app unchanged.
