import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import DashboardClient from "./DashboardClient";

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <DashboardClient 
      currentUser={{
        id: user.id,
        email: user.email,
        name: user.name || "Meta Administrator",
        role: user.role
      }} 
    />
  );
}
