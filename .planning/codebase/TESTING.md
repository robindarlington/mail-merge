# Testing Patterns

**Analysis Date:** 2026-06-24

## Test Framework

**Runner:** None. No unit test framework is installed or configured.

There is no `jest`, `vitest`, `mocha`, `node:test`, or any other test runner in `package.json` (dependencies or devDependencies).

**The `npm test` script is NOT a test suite.** It runs the sender script in preview mode:

```json
"test": "node --env-file=.env send-credentials.ts --test"
```

This invocation passes `--test` as a CLI argument to `send-credentials.ts`, which the script interprets as "send the full batch to a single redirect address". It requires an address argument:

```bash
npm run test -- you@example.com
# Equivalent to: node --env-file=.env send-credentials.ts --test you@example.com
```

This is an operational preview tool, not a unit test suite.

## Run Commands

```bash
npm run dry             # Dry run: prints what would be sent, sends nothing
npm run test -- ADDR    # Preview mode: sends all emails to ADDR (requires a real address arg)
npm run send            # Live send: sends to every recipient in the CSV
```

## Operational Verification Modes

The script has three built-in run modes that serve as manual verification steps:

**Dry run (`npm run dry`):**
- Reads and parses the CSV and template
- Prints each message's recipient and subject as `[N/total] would send -> addr`
- Makes no SMTP connection
- Use to verify CSV parsing and template substitution without any network activity

**Test/preview mode (`npm run test -- ADDR`):**
- Connects to SMTP and verifies credentials (`transport.verify()`)
- Sends the full batch, but redirects every message to `ADDR` instead of the real recipient
- Useful for end-to-end SMTP verification and email rendering checks before a live send

**Live send (`npm run send`):**
- Full live execution; sends to each real recipient

## Test File Organization

No test files exist in the repository. There is no `__tests__/`, `*.test.ts`, or `*.spec.ts` pattern.

## Coverage

**Requirements:** None enforced — no coverage tooling configured.

## What Would Need to Be Tested (if a framework were added)

Key units that have testable logic:

- `loadRecipients(path)` in `send-credentials.ts` — CSV parsing, header validation, comma-splitting, error cases (missing comma, empty fields)
- `loadTemplate(path)` in `send-credentials.ts` — Subject line extraction, body slicing, missing-subject error
- `fill(text, recipient)` in `send-credentials.ts` — `{{email}}` and `{{password}}` placeholder substitution
- `env(name, required)` in `send-credentials.ts` — Required/optional env var handling

## Adding Tests (if needed)

**Recommended framework:** `node:test` (built into Node.js 22, zero install cost) or `vitest` (if richer assertions are needed).

**Install approach for vitest:**
```bash
npm install --save-dev vitest
```

**Update `package.json`:**
```json
"scripts": {
  "test:unit": "vitest run",
  ...
}
```

**Suggested test file location:** co-located alongside the source file as `send-credentials.test.ts`, or in a `__tests__/` directory at the project root.

**Pure functions are directly testable** — `loadRecipients`, `loadTemplate`, and `fill` have no side effects beyond file I/O and string manipulation, making them straightforward to test with fixture strings or temp files.

---

*Testing analysis: 2026-06-24*
