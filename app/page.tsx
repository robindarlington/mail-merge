import { redirect } from "next/navigation";

/**
 * Root route. There is no public marketing/landing page in this phase (that is
 * Phase 9 territory), so `/` simply forwards to the app. `/dashboard` is
 * protected by proxy.ts, so signed-out visitors are redirected on to /sign-in.
 */
export default function Home() {
  redirect("/dashboard");
}
