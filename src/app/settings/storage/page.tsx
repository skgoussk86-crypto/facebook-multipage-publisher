import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import StorageSettingsClient from "./StorageSettingsClient";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login?callbackUrl=/settings/storage");
  }

  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-50 text-zinc-500 flex items-center justify-center font-mono text-xs">Loading storage settings...</div>}>
      <StorageSettingsClient />
    </Suspense>
  );
}
