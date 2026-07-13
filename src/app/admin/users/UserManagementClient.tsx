"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";

type UserRole = "ADMIN" | "USER";
type UserStatus = "ACTIVE" | "SUSPENDED";
type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  approvalStatus: ApprovalStatus;
  approvedAt: string | null;
  approvedById: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  registrationIp: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserUpdate {
  role?: UserRole;
  status?: UserStatus;
  approvalStatus?: ApprovalStatus;
  rejectionReason?: string;
}

interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export default function UserManagementClient({
  initialUsers,
  currentUser
}: {
  initialUsers: ManagedUser[];
  currentUser: CurrentUser;
}) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const counts = useMemo(() => {
    return {
      total: users.length,
      pending: users.filter(
        (user) => user.approvalStatus === "PENDING"
      ).length,
      approved: users.filter(
        (user) => user.approvalStatus === "APPROVED"
      ).length,
      rejected: users.filter(
        (user) => user.approvalStatus === "REJECTED"
      ).length
    };
  }, [users]);

  const handleUpdateUser = async (
    targetUserId: string,
    updates: UserUpdate
  ) => {
    setError(null);
    setSuccess(null);
    setUpdatingUserId(targetUserId);

    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          targetUserId,
          ...updates
        })
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to update user.");
        return;
      }

      const updatedUser: ManagedUser = {
        ...data.user,
        name: data.user.name || "Unnamed User"
      };

      setUsers((previousUsers) =>
        previousUsers.map((user) =>
          user.id === targetUserId ? updatedUser : user
        )
      );

      setSuccess("User account updated successfully.");
    } catch {
      setError("Network connection error. Try again.");
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleApprove = async (user: ManagedUser) => {
    const confirmed = window.confirm(
      `Approve ${user.name} (${user.email})?\n\nAfter approval, this user will be allowed to log in.`
    );

    if (!confirmed) {
      return;
    }

    await handleUpdateUser(user.id, {
      approvalStatus: "APPROVED"
    });
  };

  const handleReject = async (user: ManagedUser) => {
    const rejectionReason = window.prompt(
      `Enter the rejection reason for ${user.name}:`
    );

    if (rejectionReason === null) {
      return;
    }

    const cleanReason = rejectionReason.trim();

    if (!cleanReason) {
      setError("A rejection reason is required.");
      return;
    }

    await handleUpdateUser(user.id, {
      approvalStatus: "REJECTED",
      rejectionReason: cleanReason
    });
  };

  const handleLogout = async () => {
    try {
      const response = await fetch("/api/admin/login", {
        method: "DELETE"
      });

      if (response.ok) {
        window.location.href = "/login";
      }
    } catch (logoutError) {
      console.error("Logout failed:", logoutError);
    }
  };

  const formatDate = (dateValue: string | null) => {
    if (!dateValue) {
      return "Never";
    }

    return new Date(dateValue).toLocaleString();
  };

  const getApprovalBadgeClasses = (
    approvalStatus: ApprovalStatus
  ) => {
    if (approvalStatus === "APPROVED") {
      return "bg-emerald-950 text-emerald-400 border border-emerald-900/40";
    }

    if (approvalStatus === "REJECTED") {
      return "bg-rose-950 text-rose-400 border border-rose-900/40";
    }

    return "bg-amber-950 text-amber-400 border border-amber-900/40";
  };

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-zinc-950 font-sans text-zinc-100">
      <div className="flex w-full items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-xs font-bold tracking-wide text-zinc-950 shadow-md md:text-sm">
        <span>ADMINISTRATOR PORTAL</span>

        <span className="border-l border-zinc-900 pl-2 font-normal">
          Manage approvals, roles and account access.
        </span>
      </div>

      <div className="flex flex-1 flex-col md:flex-row">
        <aside className="flex w-full flex-col gap-6 border-r border-zinc-800 bg-zinc-900 p-6 md:w-64">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-600/30">
              F
            </div>

            <div>
              <h1 className="text-sm font-semibold leading-tight text-white">
                FB Multi-Page
              </h1>

              <p className="font-mono text-[10px] text-zinc-500">
                v1.0.0-phase2
              </p>
            </div>
          </div>

          <nav className="flex flex-col gap-1.5">
            <Link
              href="/"
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:bg-zinc-800/40 hover:text-zinc-200"
            >
              Overview Dashboard
            </Link>

            <Link
              href="/settings/meta-configuration"
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-400 transition hover:bg-zinc-800/40 hover:text-zinc-200"
            >
              Meta Configuration
            </Link>

            <Link
              href="/admin/users"
              className="flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-800 px-3 py-2.5 text-sm font-medium text-white shadow-inner"
            >
              User Management
            </Link>
          </nav>

          <div className="mt-auto flex flex-col gap-3 border-t border-zinc-800 pt-4">
            <div className="flex flex-col">
              <span className="truncate text-xs font-semibold text-zinc-200">
                {currentUser.name}
              </span>

              <span className="mt-0.5 truncate text-[10px] text-zinc-500">
                {currentUser.email}
              </span>

              <span className="mt-1 w-fit rounded border border-indigo-900/30 bg-indigo-950/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-indigo-400">
                {currentUser.role}
              </span>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-center text-xs font-semibold text-rose-400 transition hover:border-rose-900/30 hover:bg-rose-950/20"
            >
              Logout
            </button>
          </div>
        </aside>

        <main className="flex flex-1 flex-col bg-zinc-950 p-4 md:p-8">
          <div className="mb-8 flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-white">
                User Management
              </h2>

              <p className="text-sm text-zinc-400">
                Review registrations and control publisher access.
              </p>
            </div>

            <Link
              href="/register"
              className="w-fit rounded-lg border border-indigo-600/20 bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow shadow-indigo-600/10 transition hover:bg-indigo-500"
            >
              Add New User
            </Link>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <p className="text-xs text-zinc-500">Total Users</p>
              <p className="mt-1 text-2xl font-bold text-white">
                {counts.total}
              </p>
            </div>

            <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4">
              <p className="text-xs text-amber-500">Pending</p>
              <p className="mt-1 text-2xl font-bold text-amber-400">
                {counts.pending}
              </p>
            </div>

            <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-4">
              <p className="text-xs text-emerald-500">Approved</p>
              <p className="mt-1 text-2xl font-bold text-emerald-400">
                {counts.approved}
              </p>
            </div>

            <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 p-4">
              <p className="text-xs text-rose-500">Rejected</p>
              <p className="mt-1 text-2xl font-bold text-rose-400">
                {counts.rejected}
              </p>
            </div>
          </div>

          {error && (
            <div className="mb-6 rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-xs font-semibold text-rose-400">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-6 rounded-lg border border-emerald-900/60 bg-emerald-950/40 p-3 text-xs font-semibold text-emerald-400">
              {success}
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/40 shadow-xl backdrop-blur-md">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1250px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-zinc-800 font-mono text-xs uppercase tracking-wider text-zinc-500">
                    <th className="px-5 py-4">User</th>
                    <th className="px-5 py-4">Role</th>
                    <th className="px-5 py-4">Account</th>
                    <th className="px-5 py-4">Approval</th>
                    <th className="px-5 py-4">Registered</th>
                    <th className="px-5 py-4">Last Login</th>
                    <th className="px-5 py-4">Details</th>
                    <th className="px-5 py-4 text-right">Actions</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-zinc-800/50 text-sm text-zinc-300">
                  {users.map((user) => {
                    const isSelf = user.id === currentUser.id;
                    const isUpdating = updatingUserId === user.id;

                    return (
                      <tr
                        key={user.id}
                        className="transition hover:bg-zinc-800/20"
                      >
                        <td className="px-5 py-4">
                          <div className="font-semibold text-zinc-200">
                            {user.name}

                            {isSelf && (
                              <span className="ml-1.5 rounded border border-indigo-900/30 bg-indigo-950/40 px-1 py-0.5 font-mono text-[10px] text-indigo-400">
                                You
                              </span>
                            )}
                          </div>

                          <div className="mt-1 font-mono text-xs text-zinc-500">
                            {user.email}
                          </div>
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-xs font-semibold ${
                              user.role === "ADMIN"
                                ? "border border-indigo-900/40 bg-indigo-950 text-indigo-400"
                                : "bg-zinc-800 text-zinc-400"
                            }`}
                          >
                            {user.role}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                              user.status === "ACTIVE"
                                ? "border-emerald-900/30 bg-emerald-950 text-emerald-400"
                                : "border-rose-900/30 bg-rose-950 text-rose-400"
                            }`}
                          >
                            {user.status}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${getApprovalBadgeClasses(
                              user.approvalStatus
                            )}`}
                          >
                            {user.approvalStatus}
                          </span>

                          {user.rejectionReason && (
                            <p
                              className="mt-2 max-w-48 truncate text-xs text-rose-400"
                              title={user.rejectionReason}
                            >
                              {user.rejectionReason}
                            </p>
                          )}
                        </td>

                        <td className="px-5 py-4 font-mono text-xs text-zinc-500">
                          {formatDate(user.createdAt)}
                        </td>

                        <td className="px-5 py-4 font-mono text-xs text-zinc-500">
                          {formatDate(user.lastLoginAt)}
                        </td>

                        <td className="px-5 py-4 text-xs text-zinc-500">
                          <p>
                            IP: {user.registrationIp || "Not recorded"}
                          </p>

                          {user.approvedAt && (
                            <p className="mt-1">
                              Approved: {formatDate(user.approvedAt)}
                            </p>
                          )}

                          {user.rejectedAt && (
                            <p className="mt-1">
                              Rejected: {formatDate(user.rejectedAt)}
                            </p>
                          )}
                        </td>

                        <td className="px-5 py-4">
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {user.approvalStatus !== "APPROVED" && (
                              <button
                                type="button"
                                disabled={isSelf || isUpdating}
                                onClick={() => handleApprove(user)}
                                className="rounded border border-emerald-900/40 bg-emerald-950/30 px-2.5 py-1.5 text-xs font-semibold text-emerald-400 transition hover:border-emerald-800 hover:bg-emerald-950/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-600"
                              >
                                {isUpdating ? "Updating..." : "Approve"}
                              </button>
                            )}

                            {user.approvalStatus !== "REJECTED" && (
                              <button
                                type="button"
                                disabled={isSelf || isUpdating}
                                onClick={() => handleReject(user)}
                                className="rounded border border-rose-900/40 bg-rose-950/30 px-2.5 py-1.5 text-xs font-semibold text-rose-400 transition hover:border-rose-800 hover:bg-rose-950/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-600"
                              >
                                Reject
                              </button>
                            )}

                            <button
                              type="button"
                              disabled={isSelf || isUpdating}
                              onClick={() =>
                                handleUpdateUser(user.id, {
                                  role:
                                    user.role === "ADMIN"
                                      ? "USER"
                                      : "ADMIN"
                                })
                              }
                              className="rounded border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs font-semibold text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:border-transparent disabled:text-zinc-600"
                            >
                              Toggle Role
                            </button>

                            <button
                              type="button"
                              disabled={isSelf || isUpdating}
                              onClick={() =>
                                handleUpdateUser(user.id, {
                                  status:
                                    user.status === "ACTIVE"
                                      ? "SUSPENDED"
                                      : "ACTIVE"
                                })
                              }
                              className={`rounded border px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-zinc-600 ${
                                user.status === "ACTIVE"
                                  ? "border-rose-900/30 bg-rose-950/20 text-rose-400 hover:border-rose-900/60"
                                  : "border-emerald-900/30 bg-emerald-950/20 text-emerald-400 hover:border-emerald-900/60"
                              }`}
                            >
                              {user.status === "ACTIVE"
                                ? "Suspend"
                                : "Reactivate"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {users.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-6 py-12 text-center text-sm text-zinc-500"
                      >
                        No user accounts were found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}