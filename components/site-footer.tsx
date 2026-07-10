import { HIRE_ME_URL } from "@/lib/config";

/**
 * Attribution footer shown on every authenticated shell page (D-12 / BRAND-01).
 *
 * "Built by Robin Darlington" doubles as a lead-gen funnel: the "Hire me for
 * custom tools" link points at HIRE_ME_URL — a single placeholder constant in
 * lib/config.ts that Phase 9 flips to the live destination without touching this
 * component. Copy is sentence case with no exclamation marks per the UI-SPEC
 * Copywriting Contract; text is Label size (14px / 400) in muted-foreground.
 */
export function SiteFooter() {
  return (
    <footer className="border-t px-8 py-6">
      <p className="text-sm text-muted-foreground">
        Built by Robin Darlington{" · "}
        <a
          href={HIRE_ME_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 hover:text-foreground"
        >
          Hire me for custom tools
        </a>
      </p>
    </footer>
  );
}
