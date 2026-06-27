---
phase: 01-foundation-db-crypto-core-engine
plan: 03
subsystem: crypto
tags: [aes-256-gcm, encryption, credentials, fail-closed, security, tdd]
requires:
  - "01-01 (scaffolded Next.js app, tsx, node:test, tsconfig with bundler resolution)"
  - "01-02 (smtp_configs credential triple columns: password_enc/password_iv/password_tag)"
provides:
  - "lib/crypto/index.ts — encrypt(plaintext) / decrypt(payload) AES-256-GCM helpers"
  - "lib/crypto/key.ts — fail-closed CREDENTIAL_ENC_KEY loader (base64 → 32-byte validation)"
  - "EncryptedPayload { enc, iv, tag } type mapping to schema blob columns"
affects:
  - "Phase 2 SMTP onboarding (encrypt the user's SMTP password before persisting)"
  - "Phase 6 worker (decrypt the password at send time)"
tech-stack:
  added: []
  patterns:
    - "Node core node:crypto only — no third-party crypto library (STACK.md)"
    - "createCipheriv('aes-256-gcm') with fresh randomBytes(12) IV per call (never reused)"
    - "Persisted triple { enc, iv, tag } maps 1:1 to password_enc/password_iv/password_tag"
    - "Fail-closed runtime key loader: throws secret-free error if key absent or != 32 bytes"
    - "No secret (key/plaintext/payload) logged or serialized at any boundary"
key-files:
  created:
    - lib/crypto/key.ts
    - lib/crypto/index.ts
    - lib/crypto/crypto.test.ts
  modified: []
decisions:
  - "Key read fresh on every call (no module-level caching) so fail-closed holds regardless of import order and tests can isolate sub-scenarios in subprocesses"
  - "12-byte (96-bit) IV — the GCM-recommended size; fresh per encrypt() call"
  - "encrypt/decrypt operate on Buffers (toBuffer normalizes Uint8Array from SQLite) so the output drops straight into Drizzle blob columns"
  - "Algorithm literal inlined at both createCipheriv/createDecipheriv call sites for unambiguous auditability"
metrics:
  duration: 12
  completed: 2026-06-27
  tasks: 1
  files: 3
---

# Phase 1 Plan 03: AES-256-GCM Credential Encryption Helper Summary

The security linchpin of the product (SMTP-04, PITFALLS #1/#2): an AES-256-GCM
encrypt/decrypt helper keyed by a runtime-injected 32-byte `CREDENTIAL_ENC_KEY`
that round-trips plaintext, uses a unique IV per call, verifies the GCM auth tag
on decrypt, fails closed when the key is missing or malformed, and never leaks a
secret into ciphertext output or error messages — delivering Phase 1 success
criterion #2.

## What Was Built

### Task 1 — Fail-closed key loader + AES-256-GCM encrypt/decrypt (TDD)

`lib/crypto/key.ts` — `loadKey()` reads `process.env.CREDENTIAL_ENC_KEY`,
base64-decodes it, and asserts the decoded buffer is exactly 32 bytes, throwing a
clear, **secret-free** error otherwise (`"CREDENTIAL_ENC_KEY is missing …"` /
`"… must decode to 32 bytes (got N)"`). The key is read fresh on each call (no
caching) so the fail-closed guarantee holds regardless of import order. A
file-level comment notes that key rotation can be added later via a stored
`key_id` (PITFALLS #1) but is out of scope this phase.

`lib/crypto/index.ts` — `encrypt(plaintext: string)` generates a fresh
`randomBytes(12)` IV per call, runs `createCipheriv("aes-256-gcm", key, iv)`, and
returns `EncryptedPayload { enc, iv, tag }` (Buffers) where the GCM auth tag comes
from `cipher.getAuthTag()`. The triple maps 1:1 onto the `smtp_configs` blob
columns from plan 01-02: `enc → password_enc`, `iv → password_iv`,
`tag → password_tag`. `decrypt(payload)` calls `setAuthTag` then `final()`, which
throws on any tamper (authenticated-encryption integrity). A `toBuffer` helper
normalizes the `Uint8Array` blobs SQLite/Drizzle hand back. No `console`/`pino`
call ever touches the key, plaintext, or payload.

`lib/crypto/crypto.test.ts` (TDD, written RED-first) — 12 tests:
round-trip identity for ASCII / unicode / empty string; unique-IV-per-call (two
encryptions of the same plaintext differ in both IV and ciphertext); IV is 12
bytes + tag present; decrypt throws on tampered ciphertext and on tampered tag;
**no-secret-leak** (plaintext and key absent from the serialized payload and from
thrown error messages); and three subprocess-based fail-closed checks (unset key,
wrong-length key, and that the fail-closed error never echoes the key value).

## Verification

| Check | Result |
|-------|--------|
| `node --import tsx --test lib/crypto/crypto.test.ts` | 12 pass / 0 fail ✓ |
| `npx --no-install tsc --noEmit` | 0 errors ✓ |
| Inline gate: `CREDENTIAL_ENC_KEY= … encrypt('x')` exits 0 by catching the throw | fail-closed ✓ |
| `grep -c aes-256-gcm lib/crypto/index.ts` (algorithm present) | ✓ |
| `createCipheriv("aes-256-gcm" …)` + `randomBytes` for IV at call site | ✓ |
| `grep CREDENTIAL_ENC_KEY lib/crypto/key.ts` (loader links to env var) | ✓ |
| `.env` gitignored; `.env.example` holds only a placeholder; no real key tracked | ✓ |
| No `console`/`pino` calls in lib/crypto/*.ts | ✓ |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test file failed `tsc` on `.ts` import extension and narrowed env type**
- **Found during:** Task 1 GREEN verification (`tsc --noEmit`).
- **Issue:** The dynamic `import("./index.ts")` is rejected by tsc without
  `allowImportingTsExtensions`; and an `env` object spread to a narrowed type
  rejected assigning `CREDENTIAL_ENC_KEY`. (Same `.ts`-extension constraint plan
  01-02 hit.)
- **Fix:** Switched to extensionless `import("./index")` (tsx still resolves it)
  and annotated the spawned-subprocess env as `NodeJS.ProcessEnv`.
- **Files modified:** lib/crypto/crypto.test.ts
- **Commit:** 20638cd (folded into GREEN — the test is co-authored with the impl).

**Note on the `key_links` proxy regex:** the plan's `key_links.pattern`
(`createCipheriv\(.?'aes-256-gcm'`) assumes single-quote string literals, but the
project's established style is double quotes (CONVENTIONS.md). The algorithm
literal `createCipheriv("aes-256-gcm", …)` is present and unambiguous at both
cipher call sites and the `contains: "aes-256-gcm"` must_have is satisfied; code
was not contorted to single quotes to game the proxy.

## TDD Gate Compliance

Task 1 followed RED → GREEN:
- **RED:** `test(01-03)` commit `1710848` — 12 failing tests (ERR_MODULE_NOT_FOUND, no implementation yet).
- **GREEN:** `feat(01-03)` commit `20638cd` — key loader + encrypt/decrypt authored, 12/12 tests pass, tsc clean, fail-closed inline gate green.

No separate REFACTOR commit was required.

## Known Stubs

None. Both helpers are fully implemented and exercised by the test suite. Key
rotation (a stored `key_id`) is intentionally out of phase scope and documented
inline as a future extension — not a stub blocking this plan's goal.

## Threat Surface Scan

No new security surface beyond the plan's `<threat_model>`; the implementation
realizes every registered mitigation:
- **T-01-03a (key disclosure):** key read from `CREDENTIAL_ENC_KEY` at runtime;
  `.env` gitignored, `.env.example` holds only a placeholder, key never written to
  the repo or DB volume; no-leak test asserts key/plaintext absent from output + errors.
- **T-01-03b (ciphertext tampering):** GCM auth tag verified on decrypt; tampered
  ciphertext/tag throws (test-enforced).
- **T-01-03c (IV reuse):** fresh `randomBytes(12)` per call; unique-IV test guards reuse.
- **T-01-03d (fail-open on missing/short key):** loader throws (fail-closed) — no
  weak/empty-key encryption path exists.
- **T-01-03e (secrets in logs/errors):** no logging of key/plaintext/payload;
  error messages are secret-free; no-leak test enforces.

## Self-Check: PASSED

- lib/crypto/key.ts — FOUND
- lib/crypto/index.ts — FOUND
- lib/crypto/crypto.test.ts — FOUND
- Commit 1710848 (RED test) — FOUND
- Commit 20638cd (GREEN implementation) — FOUND
