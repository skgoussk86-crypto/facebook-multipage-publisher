import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma-client";
import UserManagementClient from "./UserManagementClient";

export const dynamic = "force-dynamic";

export default async function Page() {
  const currentUser = await getSessionUser();

  if (!currentUser) {
    redirect("/login?callbackUrl=/admin/users");
  }

  if (currentUser.role !== "ADMIN") {
    redirect("/unauthorized");
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      approvalStatus: true,
      approvedAt: true,
      approvedById: true,
      rejectedAt: true,
      rejectionReason: true,
      registrationIp: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true
    },
    orderBy: {
      createdAt: "desc"
    }
  });

  const sanitizedUsers = users.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name || "Unnamed User",
    role: user.role,
    status: user.status,
    approvalStatus: user.approvalStatus,
    approvedAt: user.approvedAt?.toISOString() ?? null,
    approvedById: user.approvedById,
    rejectedAt: user.rejectedAt?.toISOString() ?? null,
    rejectionReason: user.rejectionReason,
    registrationIp: user.registrationIp,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
  }));

  return (
    <UserManagementClient
      initialUsers={sanitizedUsers}
      currentUser={{
        id: currentUser.id,
        email: currentUser.email,
        name: currentUser.name || "Meta Administrator",
        role: currentUser.role
      }}
    />
  );
}