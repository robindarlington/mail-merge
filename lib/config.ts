/**
 * App-wide static configuration constants.
 *
 * Currently holds the attribution / funnel link surfaced in the footer (D-12).
 * The mail-merge app doubles as a lead-gen artifact, so a "hire me for custom
 * tools" link exists from day one — but the real destination is set later.
 * BRAND-01 in Phase 9 flips this single placeholder value to the live URL; no
 * other code needs to change (single-value flip, D-12).
 */

/** Live BRAND-01 destination for the footer "hire me" link (flipped in Phase 9). */
export const HIRE_ME_URL = "https://robindarlington.com/contact/";
