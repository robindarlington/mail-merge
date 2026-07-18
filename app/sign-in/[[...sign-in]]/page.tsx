import { SignIn } from "@clerk/nextjs";

/**
 * Dedicated Clerk sign-in page (D-10). Catch-all segment lets Clerk own every
 * sub-route (factor-two, SSO callback, etc.). Centered with a 3xl (64px) top
 * offset per the UI spec; no sidebar shell on auth pages.
 */
export default function SignInPage() {
  return (
    <main className="flex flex-col items-center px-4 pt-16">
      <SignIn />
    </main>
  );
}
