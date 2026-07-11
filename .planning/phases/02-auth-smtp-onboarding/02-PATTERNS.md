# Phase 2: Auth + SMTP Onboarding - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** 28 new/modified
**Analogs found:** 20 / 28 (8 greenfield — Clerk/shadcn, use RESEARCH.md code examples)

> **Phase character:** This is a *wiring* phase (RESEARCH.md Summary). Everything hard
> (crypto, DB opener, SMTP transport) already exists in `lib/`. The `lib/**` new files have
> strong Phase-1 analogs to copy from; the UI layer (Clerk pages, shadcn components, Server
> Actions) is genuinely new and leans on RESEARCH.md Code Examples 1–7 instead of a repo analog.
> Do NOT re-invent transport/crypto/DB-opener code — extend/compose the existing `lib/` modules.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `proxy.ts` | middleware | request-response | *(none — Clerk)* | no-analog |
| `app/layout.tsx` (MODIFY) | provider/layout | request-response | `app/layout.tsx` (current) | exact |
| `app/page.tsx` (MODIFY) | route | request-response | `app/page.tsx` (current) | exact |
| `app/sign-in/[[...sign-in]]/page.tsx` | page | request-response | *(none — Clerk)* | no-analog |
| `app/sign-up/[[...sign-up]]/page.tsx` | page | request-response | *(none — Clerk)* | no-analog |
| `app/(app)/layout.tsx` | layout (shell) | request-response | `app/layout.tsx` (current) | role-match |
| `app/(app)/dashboard/page.tsx` | page | request-response | `app/page.tsx` (current) | role-match |
| `app/(app)/settings/smtp/page.tsx` | page (wizard/edit) | request-response | *(none)* | no-analog |
| `components/app-sidebar.tsx` | component | request-response | *(none — shadcn CLI)* | no-analog |
| `components/site-footer.tsx` | component | request-response | *(none)* | no-analog |
| `components/smtp/*` (wizard steps) | component (form) | request-response | *(none — RHF/shadcn)* | no-analog |
| `lib/config.ts` | config | — | `lib/crypto/key.ts` (constant + JSDoc) | role-match |
| `lib/smtp/schema.ts` | validation (zod) | transform | RESEARCH Code Example 6 + `lib/` style | role-match |
| `lib/smtp/errors.ts` | utility (classifier) | transform | `lib/core/send.ts` `sendOne` err-map (96–111) | role-match |
| `lib/smtp/verify.ts` | service | request-response | `lib/core/send.ts` `createSmtpTransport`/`verifyTransport` (69–89) | exact |
| `lib/smtp/actions.ts` | service (Server Action) | request-response | `scripts/migrate.ts` (compose lib/) + RESEARCH Ex 7 | role-match |
| `lib/smtp/index.ts` | barrel | — | `lib/core/index.ts` | exact |
| `lib/data/smtp.ts` | model (DAL/DTO) | CRUD | `lib/db/client.ts` + `schema.ts` (query/pick) | role-match |
| `lib/data/index.ts` | barrel | — | `lib/db/index.ts` | exact |
| `lib/smtp/schema.test.ts` | test | — | `lib/crypto/crypto.test.ts` | role-match |
| `lib/smtp/errors.test.ts` | test | — | `lib/core/send.test.ts` (table stubs) | role-match |
| `lib/smtp/verify.test.ts` | test | — | `lib/core/send.test.ts` (stub transport) | exact |
| `lib/smtp/actions.test.ts` | test | — | `lib/core/send.test.ts` (stub transport) | role-match |
| `lib/data/smtp.test.ts` | test | — | `lib/crypto/crypto.test.ts` (temp env/DB) | role-match |
| `lib/data/dto.test.ts` | test | — | `lib/crypto/crypto.test.ts` (redaction asserts 77–106) | exact |
| `drizzle/000X_*.sql` (unique index) | migration | — | `drizzle/0000_clear_absorbing_man.sql` | exact |
| `Dockerfile` (MODIFY — build ARG) | config | — | `Dockerfile` (current) | exact |
| `docker-compose.yml` (MODIFY — Clerk env) | config | — | `docker-compose.yml` (current) | exact |

---

## Pattern Assignments

### `lib/smtp/verify.ts` (service, request-response)

**Analog:** `lib/core/send.ts` (the transport factory + `verifyTransport` gate). RESEARCH Pattern 4 / Code Example 4 says to **extend** `SmtpConfig` with optional timeout fields rather than add a second factory — so the analog is not just a style reference, it is the module being extended.

**Transport-factory pattern to reuse/extend** (`lib/core/send.ts:69-89`):
```ts
export function createSmtpTransport(config: SmtpConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,               // verbatim — NEVER inferred from port
    auth: { user: config.auth.user, pass: config.auth.pass },
  });
}
export async function verifyTransport(
  transport: Pick<MailTransport, "verify">,
): Promise<unknown> {
  if (typeof transport.verify !== "function") {
    throw new Error("transport does not support verify()");
  }
  return transport.verify();
}
```

**How to extend (additive, keeps single-factory contract):** add optional
`requireTLS?`, `connectionTimeout?`, `greetingTimeout?`, `socketTimeout?`, `dnsTimeout?`
to `SmtpConfig`, pass them through in `createSmtpTransport`. `verify.ts` then calls the
factory with the `ONBOARDING_TIMEOUTS` block (10s/10s/15s/10s per Pitfall 4) and
`requireTLS: !secure`, wraps `verify()` in try/finally with `transport.close()`, and does the
D-05 alternate-mode retry. Full shape in RESEARCH Code Example 4 (`verifySmtp`).

**Structured-result contract to mirror** (`lib/core/send.ts:59-61`) — verify returns a value,
never a thrown raw error:
```ts
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: { message: string; code?: string } };
```

---

### `lib/smtp/errors.ts` (utility, transform)

**Analog:** the inline error-mapping in `lib/core/send.ts` `sendOne` (lines 101-110) — pull
`{ message, code }` off an `unknown` catch, never pass the raw `Error` outward.

```ts
} catch (err) {
  const e = err as { message?: string; code?: string };
  return {
    ok: false,
    error: {
      message: e?.message ?? String(err),
      ...(e?.code ? { code: e.code } : {}),
    },
  };
}
```

**New work (no repo analog for the classifier itself):** the `classifyVerifyError` mapping of
`EAUTH` / `ETIMEDOUT` / `EDNS` / `ECONNECTION` / `ESOCKET` / TLS-shape → `{ kind, field }` is
new — copy it verbatim from RESEARCH Code Example 4. Keep the same "read `.code`/`.message`
off a duck-typed error, return a typed value" style as the analog above.

---

### `lib/smtp/schema.ts` (validation, transform)

**Analog:** no zod file exists yet in-repo; use RESEARCH Code Example 6 as the source of truth.
Match the `lib/` house style (file-level JSDoc header, 2-space, double quotes, semicolons,
`export type X = ...` beside the value — as in `send.ts:59` / `crypto/index.ts:35`).

**zod 4 gotchas (Pitfall 7):** `z.email()` top-level (not `z.string().email()`);
`z.coerce.number().int().min(1).max(65535)` for port. Add the Pitfall-9 refinement rejecting
loopback/link-local/RFC1918 host literals.

---

### `lib/data/smtp.ts` (model — DAL + DTO redaction, CRUD)

**Analog:** `lib/db/client.ts` (import path + sole-opener rule) and `lib/db/schema.ts`
(row types). No DAL exists yet — this file *establishes* the `userId`-scoped DAL convention all
later phases inherit (AUTH-02). Follow RESEARCH Pattern 2/3 + Code Example 5.

**Import + sole-opener rule to honor** (`lib/db/index.ts:8-9` barrel; never `new Database()`):
```ts
import { db } from "@/lib/db";
import { smtp_configs, type SmtpConfig } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
```
> `lib/db/client.ts:1-13` header: "This is the ONLY module permitted to construct a
> better-sqlite3 Database … Do NOT call `new Database(...)` anywhere else."

**Column names for the DTO picker & upsert** (from `lib/db/schema.ts:41-58`) — the DTO
**explicitly picks** safe fields and structurally cannot include the encrypted triple:
- safe to expose: `host, port, secure, username, from_addr, from_name, verified_at`
- NEVER expose: `password_enc, password_iv, password_tag` (the only password representation)
- encrypt() output maps 1:1: `enc→password_enc, iv→password_iv, tag→password_tag`
  (`lib/crypto/index.ts:6-8`)

**Every function takes `userId` as required first param** (AUTH-02) — see RESEARCH Code
Example 5 `getSmtpConfigForUser` / `upsertSmtpConfig` / `toSmtpConfigDto`. Upsert conflict
target `smtp_configs.userId` requires the additive unique-index migration (see below).

---

### `lib/smtp/actions.ts` (service — Server Actions, request-response)

**Analog:** `scripts/migrate.ts` shows the house pattern for *composing* `lib/` modules
(imports `db, connection` from `../lib/db`, orchestrates, never re-implements). Server Actions
compose the same way: `auth()` → `smtpFormSchema` → `verifySmtp` (lib/smtp) → `encrypt`
(lib/crypto) → `upsertSmtpConfig` (lib/data). Full skeleton in RESEARCH Code Example 7.

**Auth-first + typed-return pattern (new — Clerk):** every action begins
`const { userId } = await auth(); if (!userId) return { ok: false, error: { kind: "unauthenticated" } };`
and returns typed `{ ok } | { ok: false, error: {...} }` — NEVER a thrown/serialized raw
nodemailer error (Pitfall 5). This mirrors the analog's "return a value, don't throw outward"
contract from `send.ts:59-61`.

**Two distinct actions (D-08 / Pitfall 6):** `verifyAndSave` (connection fields → always
verifies, sets `verified_at`) vs `updateFromFields` (from_name/from_addr only → direct save,
`verified_at` untouched). Structurally separate so `verified_at` can never survive a
connection-field change.

---

### `lib/smtp/index.ts` & `lib/data/index.ts` (barrels)

**Analog:** `lib/core/index.ts` (`lib/core/index.ts:9-27`) and `lib/db/index.ts:8-9`.
Copy the exact shape: file-level JSDoc explaining who consumes it, then `export { … } from
"./x"` value exports followed by `export type { … } from "./x"`.

```ts
export { db, connection, type Db } from "./client";
export * from "./schema";
```

---

### `app/layout.tsx` (MODIFY — provider/layout)

**Analog:** the current `app/layout.tsx` (exact — you are editing it). Keep the existing Geist
font + `cn` + metadata; the only change is wrapping children in `<ClerkProvider appearance={{
theme: shadcn }}>` **inside `<body>`** (RESEARCH Code Example 2; Clerk rule: provider goes
inside `<body>`, not around `<html>`).

**Current structure to preserve** (`app/layout.tsx:6-23`):
```tsx
const geist = Geist({subsets:['latin'],variable:'--font-sans'});
export const metadata: Metadata = { title: "Mail Merge", description: "…" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>{children}</body>   {/* wrap children with <ClerkProvider> here */}
    </html>
  );
}
```

---

### `app/page.tsx` (MODIFY — root redirect)

**Analog:** current `app/page.tsx` (exact — replace its placeholder body). Per RESEARCH Open
Question 4, `/` server-redirects to `/dashboard` (proxy protects it). The current inline-styled
placeholder (`app/page.tsx:1-23`) is discarded in favor of a `redirect("/dashboard")`.

---

### `app/(app)/layout.tsx` + `app/(app)/dashboard/page.tsx` (shell + dashboard)

**Analog:** `app/layout.tsx` for the RSC layout shape; `app/page.tsx` for a minimal RSC page.
The sidebar/footer composition itself is new (shadcn `sidebar` + `UserButton` + `site-footer`).
Dashboard hosts the D-02 soft-gate callout as the dominant element for a fresh account (calls
`getSmtpConfigForUser(userId)` to decide callout vs "configured" state).

---

### `drizzle/000X_smtp_configs_user_uq.sql` (migration)

**Analog:** `drizzle/0000_clear_absorbing_man.sql` (exact — same generated format). Generate via
`npm run db:generate` (drizzle-kit), do NOT hand-write. The additive change is a UNIQUE index so
`onConflictDoUpdate({ target: smtp_configs.userId })` is race-safe (RESEARCH Pattern 5):
`CREATE UNIQUE INDEX smtp_configs_user_uq ON smtp_configs(user_id);`. Add it in
`lib/db/schema.ts` on the `smtp_configs` table (the `unique(...)` helper is already imported and
used on `send_records`, `schema.ts:138`), then generate.

---

### `Dockerfile` + `docker-compose.yml` (MODIFY — deploy)

**Analog:** current `Dockerfile` / `docker-compose.yml` (exact — editing in place). Per Pitfall 3
add `ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (+ sign-in/up URL vars) to the **build** stage
(`Dockerfile:30-34`, before `npm run build`) because `NEXT_PUBLIC_*` is inlined at build time.
`CLERK_SECRET_KEY` stays **runtime-only** in the compose `web.environment` block
(`docker-compose.yml:24-33`, alongside `CREDENTIAL_ENC_KEY`) — never a build arg, never baked
into the image. Follow the existing secret-injection style (`${CREDENTIAL_ENC_KEY}` from host env).

---

## Shared Patterns

### File-level JSDoc header (ALL `lib/**` files)
**Source:** every `lib/` module — e.g. `lib/core/send.ts:1-26`, `lib/crypto/index.ts:1-23`,
`lib/db/client.ts:1-13`.
**Apply to:** all new `lib/smtp/*` and `lib/data/*` files.
Pattern: a `/** … */` block stating (a) what the module is, (b) which requirement IDs / decisions
it satisfies (e.g. `SMTP-04`, `D-04`), (c) security/purity constraints. Single-line `/** … */`
JSDoc on every exported function stating its contract.

### Secret-safety redaction (grep-enforced) — SMTP-04 / Pitfall 5
**Source:** `lib/core/send.ts:18-22` header rule + `lib/crypto/index.ts:16-18`.
**Apply to:** all of `lib/smtp/*`, `lib/data/*`, and Server Actions.
```
// NEVER logs the password, the auth object, or the full transport config.
// It does not log at all — callers log host/user/result through their own redacting logger.
```
Concrete rules: no `console.*`/`pino` call referencing `pass|password`; never put a raw
nodemailer error or the config row into a Server Action return; `toSmtpConfigDto()` is the sole
server→client boundary crosser. Extend the Phase-1 grep gate to `lib/smtp` + `lib/data`.

### Structured typed result, never throw outward
**Source:** `lib/core/send.ts:59-61` (`SendResult` union) + `sendOne` (96-111).
**Apply to:** `lib/smtp/verify.ts`, `lib/smtp/errors.ts`, all Server Actions.
Return `{ ok: true, … } | { ok: false, error }`. Raw error text goes only into an expandable-
detail field (D-06), classified into `{ kind, field }` first.

### `userId`-scoped data access (AUTH-02)
**Source:** `lib/db/schema.ts:16-18` convention header ("Every tenant-owned table carries
`userId` … for multi-tenant scoping").
**Apply to:** every function in `lib/data/smtp.ts` and every Server Action.
`userId` is a required first parameter; there is no unscoped query path. Server always re-derives
identity via `await auth()` — never trusts a client-supplied id.

### Test structure (node:test + tsx)
**Source:** `lib/crypto/crypto.test.ts` (secret-redaction + subprocess fail-closed) and
`lib/core/send.test.ts` (duck-typed stub transport).
**Apply to:** all Phase-2 test files. Framework: `node:test` + `node:assert/strict`, no config
file; run `node --import tsx --test <file>`.
- **Stub transport** (no live SMTP) — `send.test.ts:15-33`: any object with `sendMail`/`verify`
  exercises the contract. Reuse for `verify.test.ts` / `actions.test.ts` (inject a mock transport).
- **Set env before dynamic import** — `crypto.test.ts:18-22`: set `CREDENTIAL_ENC_KEY` (and, for
  `lib/data/*.test.ts`, a temp `DATABASE_PATH`) then `await import(...)`.
- **Redaction assertion** — `crypto.test.ts:77-106`: assert a known marker password never appears
  in `JSON.stringify` of any outward shape (directly the `dto.test.ts` pattern for SMTP-04).
- **Subprocess for env-sensitive scenarios** — `crypto.test.ts:110-159`: `execFileSync(process.execPath,
  ["--import","tsx","-e",script], { env })` to test missing-key / isolated behavior without mutating
  this process's env.

---

## No Analog Found

Files with no close repo match — planner should use RESEARCH.md Code Examples (Clerk/shadcn/RHF
are external, first-in-repo introductions):

| File | Role | Reason | Use Instead |
|------|------|--------|-------------|
| `proxy.ts` | middleware | First Clerk middleware; Next 16 `proxy.ts` name (NOT `middleware.ts`) | RESEARCH Code Example 1 |
| `app/sign-in/[[...sign-in]]/page.tsx` | page | First Clerk prebuilt component | RESEARCH Code Example 3 |
| `app/sign-up/[[...sign-up]]/page.tsx` | page | First Clerk prebuilt component | RESEARCH Code Example 3 |
| `app/(app)/settings/smtp/page.tsx` | page | First multi-step wizard entry | RESEARCH Architecture diagram + D-01 |
| `components/app-sidebar.tsx` | component | shadcn `sidebar` CLI-scaffolded; no component exists yet | shadcn CLI + D-11 |
| `components/site-footer.tsx` | component | First footer; reads `HIRE_ME_URL` from `lib/config.ts` | D-12 |
| `components/smtp/*` | component (form) | First react-hook-form + zod-resolver forms | shadcn form docs + D-06 |
| `lib/config.ts` | config | First app-config constant (`HIRE_ME_URL` placeholder) | Specifics note + D-12 (single value Phase 9 flips) |

---

## Metadata

**Analog search scope:** `app/`, `lib/{core,crypto,db}`, `components/`, `scripts/`, `drizzle/`,
`worker/`, root config (`Dockerfile`, `docker-compose.yml`, `package.json`, `components.json`).
**Files scanned (read in full or targeted):** 15
**Pattern extraction date:** 2026-07-10
**Key insight:** `components/` has no existing files and no page/component/DAL layer exists yet —
Phase 2 establishes those conventions. The reusable depth is entirely in `lib/{core,crypto,db}`,
which the new `lib/{smtp,data}` modules compose and extend (never duplicate).
