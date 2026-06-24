# Coding Conventions

**Analysis Date:** 2026-06-24

## Naming Patterns

**Files:**
- Single kebab-case file for the main script: `send-credentials.ts`
- Template file uses kebab-case: `email-template.txt`

**Functions:**
- camelCase for all functions: `loadRecipients`, `loadTemplate`, `fill`, `env`, `promptHidden`, `main`
- Names are verb-first and descriptive of what they do

**Variables:**
- camelCase for local variables: `fromName`, `fromAddr`, `testAddr`, `testIdx`
- SCREAMING_SNAKE_CASE for module-level constants: `HERE`, `CSV_PATH`, `TEMPLATE_PATH`, `DELAY_MS`
- Short, contextual names in tight loops: `r` for recipient, `i` for index, `l` for line

**Types:**
- PascalCase for type aliases: `Recipient`
- Inline type annotations on function parameters and return types

## Code Style

**Formatting:**
- No formatter config file detected (no `.prettierrc`, `.eslintrc`, or `biome.json`)
- Consistent 2-space indentation throughout `send-credentials.ts`
- Trailing commas in multi-line object/array literals
- Double quotes for strings
- Semicolons present

**Linting:**
- No linter configured

**TypeScript:**
- No `tsconfig.json` — the script runs directly via `node send-credentials.ts` using Node.js 22+ native TypeScript support (type stripping)
- Type assertions used sparingly: `(e as Error).message` for caught errors, `rl as unknown as { ... }` for unsafe internal readline API access
- `type` keyword used for object shapes (`type Recipient`)

## Import Organization

**Order (as observed in `send-credentials.ts`):**
1. Node built-in modules using `node:` prefix (`node:fs`, `node:path`, `node:url`, `node:readline`)
2. Third-party packages (`nodemailer`)

**Path Aliases:**
- None — project has a single file with no internal imports

**Module System:**
- ESM (`"type": "module"` in `package.json`)
- Bare `import` statements, no `require()`

## Error Handling

**Patterns:**
- Synchronous functions throw `new Error(message)` with descriptive messages that include context (e.g., the bad value or row number)
- The top-level `main()` call uses `.catch()` to print `ERROR: <message>` to stderr and exit with code 1
- Inside the send loop, individual send failures are caught per-recipient with `try/catch` so one failure does not abort the batch; errors are logged to stdout with a `FAILED ->` prefix
- Environment variable access is centralized in `env(name, required)` which throws on missing required vars

**Pattern — never silently swallow errors:**
```typescript
// Per-recipient failures: log and continue
} catch (e) {
  console.log(`${tag} FAILED -> ${to}: ${(e as Error).message}`);
}

// Top-level: hard exit
main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});
```

## Logging

**Framework:** `console.log` / `console.error` (no logging library)

**Patterns:**
- Structured prefix tags for progress: `[1/42] sent -> addr`
- Mode banners printed at startup: `DRY RUN:`, `TEST mode:`, `LIVE mode:`
- `console.error` used only for fatal top-level errors
- No timestamps or log levels

## Comments

**When to Comment:**
- File-level JSDoc block at top of `send-credentials.ts` explains purpose and all run commands
- Single-line `/** ... */` JSDoc on every exported/top-level function explaining its contract
- Inline comments for non-obvious decisions (e.g., `// 465 = implicit SSL; 587 uses STARTTLS automatically`, `// hide everything typed after the prompt is shown`)
- Constants annotated inline: `const DELAY_MS = 3000; // pause between sends...`

**Pattern:**
```typescript
/** Minimal CSV reader: header row + one row per line, split at the FIRST comma
 *  (so passwords may safely contain commas). */
function loadRecipients(path: string): Recipient[] { ... }
```

## Function Design

**Size:** Functions are small and single-purpose (10–20 lines each). `main()` is the only longer function (~65 lines) and is the orchestration entry point.

**Parameters:** Functions accept typed parameters. No optional parameters except `required = true` in `env()`.

**Return Values:**
- Pure functions return typed values: `Recipient[]`, `{ subject: string; body: string }`, `string`
- Async functions return `Promise<string>` or `Promise<void>`
- No untyped `any` returns

## Module Design

**Exports:** None — this is a single-file CLI script. Everything is file-scoped.

**Barrel Files:** Not applicable (single file project).

**Constants block:** Module-level constants are grouped at the top of the file after imports.

**Entry point pattern:**
```typescript
// All logic lives in async main(), called at the bottom:
main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});
```

---

*Convention analysis: 2026-06-24*
