import { SignUp } from "@clerk/nextjs";

/**
 * Dedicated Clerk sign-up page (D-10). Mirrors the sign-in page: catch-all
 * segment, centered with a 3xl (64px) top offset, no sidebar shell.
 */
export default function SignUpPage() {
  return (
    <main className="flex min-h-screen flex-col items-center px-4 pt-16">
      <SignUp />
    </main>
  );
}
