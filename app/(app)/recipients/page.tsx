import { redirect } from "next/navigation";

/**
 * /recipients — redirect stub kept alive after the page was renamed to /lists,
 * so old bookmarks and in-app links never hit a dead URL. Server-redirects to
 * /lists on load (route-level; no next.config rewrite needed).
 */
export default function RecipientsRedirectPage() {
  redirect("/lists");
}
