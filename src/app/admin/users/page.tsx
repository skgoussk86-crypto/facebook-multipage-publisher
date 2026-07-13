import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma-client";
import UserManagementClient from "./UserManagementClient";

export const dynamic = 'force-dynamic';

export default async function Page() {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login?callbackUrl=/admin/users");
  }

  if (user.role !== "ADMIN") {
    redirect("/unauthorized");
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" }
  });

  const sanitizedUsers = users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name || "Meta Administrator",
    role: u.role,
    status: u.status,
    createdAt: u.createdAt.toISOString()
  }));

  return (
    <UserManagementClient 
      initialUsers={sanitizedUsers} 
      currentUser={{ id: user.id, email: user.email, name: user.name || "Meta Administrator", role: user.role }} 
    />
  );
}
