import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import MetaConfigurationClient from "./MetaConfigurationClient";

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login?callbackUrl=/settings/meta-configuration");
  }

  return <MetaConfigurationClient adminEmail={user.email} />;
}
