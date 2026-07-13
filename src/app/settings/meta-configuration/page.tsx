import { getSessionUser } from "@/lib/auth";
import LoginClient from "./LoginClient";
import MetaConfigurationClient from "./MetaConfigurationClient";

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await getSessionUser();

  if (!user) {
    return <LoginClient />;
  }

  return <MetaConfigurationClient adminEmail={user.email} />;
}

