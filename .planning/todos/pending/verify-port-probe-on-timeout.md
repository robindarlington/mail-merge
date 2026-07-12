---
created: 2026-07-13
title: "Wizard: probe alternate port (465↔587) on connection-timeout verify failure"
area: smtp-onboarding
source: prod debugging 2026-07-13 (VPS blocked outbound 465; 587 open)
severity: enhancement
---

A user whose VPS/host blocks outbound 465 sees "can't connect to server" with no
hint that 587 would work. The verify engine already probes the alternate TLS mode
on TLS-shaped failures — extend the same pattern to connection timeouts: probe the
alternate port/TLS-mode pair and offer a one-click "Port 465 seems blocked — try
587 with STARTTLS?" switch. This is exactly the failure mode shared-hosting
freelance clients will hit. Candidate for a polish phase.
