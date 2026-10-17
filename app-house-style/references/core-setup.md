# Setting up a portable package (engine/, client/, keys/ ...)

Root `package.json`: npm workspaces, `"engines": { "node": ">=22.18.0" }` (the first release
that runs `.ts` with type stripping on by default; take the reference app's pin when there is
one), and `lint`/`typecheck`/`test` scripts that run across the workspaces with
`--if-present`. Dev dependencies, pinned exactly: `typescript` (5.8 or later, for
`erasableSyntaxOnly`), `@types/node`, `eslint` (9), `@eslint/js`, `typescript-eslint`.

Each portable package:

```json
{
  "name": "@<app>/<pkg>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
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
`src` and `test`, which is why the lint below must refuse Node built-ins on its own.
Imports use `.ts` extensions.

`eslint.config.mjs`:

```js
import { builtinModules } from "node:module";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// <why this package must stay portable, in one sentence>
const NEUTRAL = "<pkg>/src is platform-neutral.";
const CLOCK = "Pass time in; <pkg>/src has no clock.";
const PORTABLE_CORE = {
  files: ["src/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", { patterns: [
      { group: ["node:*", ...builtinModules, ...builtinModules.map((m) => `${m}/*`)], message: NEUTRAL }] }],
    "no-restricted-properties": ["error",
      { object: "Math", property: "random", message: "Randomness comes in as an argument." },
      { object: "Date", property: "now", message: CLOCK },
      { object: "globalThis", message: NEUTRAL }],
    "no-restricted-syntax": ["error",
      { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK },
      { selector: "CallExpression[callee.name='Date']", message: CLOCK }],
    "no-restricted-globals": ["error",
      ...["process", "window", "self", "crypto", "performance"].map((name) => ({ name, message: NEUTRAL })),
      { name: "fetch", message: "<pkg>/src does no I/O. The caller fetches." }],
      // client/ also bans document, localStorage, indexedDB, setTimeout, clearTimeout,
      // setInterval and WebSocket ("Use platform.<x>").
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

Lint is a tripwire, not a proof: the real test is running the core where the platform is
absent (plain Node with `types: []`, and Hermes for a native host).

Schemas: zod (v4) in the engine is fine (it runs everywhere, and `z.toJSONSchema` gives MCP and
CLI descriptions). Cryptography: only `@noble/curves`, `@noble/ciphers`, `@noble/hashes` (and
CryptoKit on Apple's side), composed by us and checked against published test vectors.

CI (`.github/workflows/ci.yml`): one `check` job on the house's self-hosted runner label,
running `npm ci`, lint, typecheck, test (and the web build). It may skip drafts
(`if: ${{ !github.event.pull_request.draft }}`), but then the trigger must list
`types: [opened, synchronize, reopened, ready_for_review]`: a skipped job counts as passing,
and without `ready_for_review` a PR marked ready with no new push merges with CI never run.

Add a `review decision` check: it fails unless the PR body has exactly one `Code-Review:` and
one `Simplify:` line, and it reads only the PR body, so it runs no PR code. Copy the reference
app's workflow when there is one (this skills repository's
`.github/workflows/review-decision.yml` otherwise), with `runs-on` set to the house's runners.
