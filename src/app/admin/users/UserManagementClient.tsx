"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";

type UserRole = "ADMIN" | "USER";
type UserStatus = "ACTIVE" | "SUSPENDED";
type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";
type ApprovalFilter = "ALL" | ApprovalStatus;

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

interface UserManagementClientProps {
  initialUsers: ManagedUser[];
  currentUser: CurrentUser;
}

export default function UserManagementClient({
  initialUsers,
  currentUser
}: UserManagementClientProps) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(
    null
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [approvalFilter, setApprovalFilter] =
    useState<ApprovalFilter>("ALL");

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

  const filteredUsers = useMemo(() => {
    const normalizedSearch = searchTerm.toLowerCase().trim();

    return users.filter((user) => {
      const matchesApproval =
        approvalFilter === "ALL" ||
        user.approvalStatus === approvalFilter;

      const matchesSearch =
        !normalizedSearch ||
        user.name.toLowerCase().includes(normalizedSearch) ||
        user.email.toLowerCase().includes(normalizedSearch);

      return matchesApproval && matchesSearch;
    });
  }, [approvalFilter, searchTerm, users]);

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const handleUpdateUser = async (
    targetUserId: string,
    updates: UserUpdate
  ) => {
    clearMessages();
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
      setError("Network connection error. Please try again.");
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
      setSuccess(null);
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

  const formatDateTime = (dateValue: string | null) => {
    if (!dateValue) {
      return "Never";
    }

    return new Date(dateValue).toLocaleString();
  };

  const getApprovalBadgeClasses = (
    approvalStatus: ApprovalStatus
  ) => {
    if (approvalStatus === "APPROVED") {
      return "border-emerald-900/50 bg-emerald-950/60 text-emerald-400";
    }

    if (approvalStatus === "REJECTED") {
      return "border-rose-900/50 bg-rose-950/60 text-rose-400";
    }

    return "border-amber-900/50 bg-amber-950/60 text-amber-400";
  };

  const getStatusBadgeClasses = (status: UserStatus) => {
    if (status === "ACTIVE") {
      return "border-emerald-900/40 bg-emerald-950/40 text-emerald-400";
    }

    return "border-rose-900/40 bg-rose-950/40 text-rose-400";
  };

  const getRoleBadgeClasses = (role: UserRole) => {
    if (role === "ADMIN") {
      return "border-indigo-900/50 bg-indigo-950/60 text-indigo-400";
    }

    return "border-zinc-700 bg-zinc-800 text-zinc-400";
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 font-sans text-zinc-900">
      <div className="flex min-h-10 w-full items-center justify-center gap-2 bg-amber-50 text-amber-800 border-b border-amber-200 px-4 py-2 text-center text-xs font-bold tracking-wide shadow-sm md:text-sm">
        <span>ADMINISTRATOR PORTAL</span>

        <span className="hidden border-l border-amber-300 pl-2 font-normal sm:inline">
          Manage approvals, roles and account access.
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col md:flex-row">
        <aside className="flex w-full flex-col border-b border-zinc-200 bg-white p-5 md:min-h-[calc(100vh-40px)] md:w-60 md:flex-shrink-0 md:border-b-0 md:border-r lg:border-zinc-200">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-600/30">
              F
            </div>

            <div className="min-w-0">
              <h1 className="text-sm font-semibold leading-tight text-zinc-900">
                FB Multi-Page
              </h1>

              <p className="font-mono text-[10px] text-zinc-500">
                v1.0.0-phase2
              </p>
            </div>
          </div>

          <nav className="mt-6 grid grid-cols-2 gap-2 md:flex md:flex-col md:gap-1.5">
            <Link
              href="/"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 md:text-left md:text-sm"
            >
              Overview
            </Link>

            <Link
              href="/settings/meta-configuration"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 md:text-left md:text-sm"
            >
              Meta Settings
            </Link>

            <Link
              href="/settings/storage"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 md:text-left md:text-sm"
            >
              Storage Settings
            </Link>

            <Link
              href="/admin/users"
              className="rounded-lg border border-indigo-700 bg-indigo-600 px-3 py-2.5 text-center text-xs font-semibold text-white shadow-sm md:text-left md:text-sm"
            >
              Users
            </Link>
          </nav>

          <div className="mt-5 flex items-center justify-between gap-3 border-t border-zinc-200 pt-4 md:mt-auto md:block">
            <div className="min-w-0">
              <span className="block truncate text-xs font-semibold text-zinc-800">
                {currentUser.name}
              </span>

              <span className="mt-0.5 block truncate text-[10px] text-zinc-500">
                {currentUser.email}
              </span>

              <span className="mt-1 inline-flex rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-indigo-700">
                {currentUser.role}
              </span>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="flex-shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-800 transition hover:bg-rose-100 md:mt-4 md:w-full"
            >
              Logout
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-7xl">
            <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-2xl font-bold tracking-tight text-zinc-900">
                  User Management
                </h2>

                <p className="mt-1 text-sm text-zinc-500">
                  Review registrations and control publisher access.
                </p>
              </div>

              <Link
                href="/register"
                className="w-fit rounded-lg border border-indigo-600 bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white shadow shadow-indigo-600/20 transition hover:bg-indigo-500"
              >
                Add New User
              </Link>
            </div>

            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <button
                type="button"
                onClick={() => setApprovalFilter("ALL")}
                className={`rounded-xl border p-4 text-left transition ${
                  approvalFilter === "ALL"
                    ? "border-indigo-500 bg-indigo-50/50"
                    : "border-zinc-200 bg-white hover:border-zinc-300"
                }`}
              >
                <p className="text-xs text-zinc-500">Total Users</p>

                <p className={`mt-1 text-2xl font-bold ${approvalFilter === "ALL" ? "text-indigo-600" : "text-zinc-900"}`}>
                  {counts.total}
                </p>
              </button>

              <button
                type="button"
                onClick={() => setApprovalFilter("PENDING")}
                className={`rounded-xl border p-4 text-left transition ${
                  approvalFilter === "PENDING"
                    ? "border-amber-400 bg-amber-50"
                    : "border-zinc-200 bg-white hover:border-amber-300"
                }`}
              >
                <p className="text-xs text-amber-800">Pending</p>

                <p className="mt-1 text-2xl font-bold text-amber-600">
                  {counts.pending}
                </p>
              </button>

              <button
                type="button"
                onClick={() => setApprovalFilter("APPROVED")}
                className={`rounded-xl border p-4 text-left transition ${
                  approvalFilter === "APPROVED"
                    ? "border-emerald-400 bg-emerald-50"
                    : "border-zinc-200 bg-white hover:border-emerald-300"
                }`}
              >
                <p className="text-xs text-emerald-800">Approved</p>

                <p className="mt-1 text-2xl font-bold text-emerald-600">
                  {counts.approved}
                </p>
              </button>

              <button
                type="button"
                onClick={() => setApprovalFilter("REJECTED")}
                className={`rounded-xl border p-4 text-left transition ${
                  approvalFilter === "REJECTED"
                    ? "border-rose-400 bg-rose-50"
                    : "border-zinc-200 bg-white hover:border-rose-300"
                }`}
              >
                <p className="text-xs text-rose-800">Rejected</p>

                <p className="mt-1 text-2xl font-bold text-rose-600">
                  {counts.rejected}
                </p>
              </button>
            </div>

            <div className="mb-5 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-3 sm:flex-row sm:items-center">
              <input
                type="search"
                value={searchTerm}
                onChange={(event) =>
                  setSearchTerm(event.target.value)
                }
                placeholder="Search by name or email..."
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
              />

              <select
                value={approvalFilter}
                onChange={(event) =>
                  setApprovalFilter(
                    event.target.value as ApprovalFilter
                  )
                }
                className="rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-indigo-600"
              >
                <option value="ALL">All approvals</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
              </select>
            </div>

            {error && (
              <div className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
                {error}
              </div>
            )}

            {success && (
              <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">
                {success}
              </div>
            )}

            <div className="grid gap-4">
              {filteredUsers.map((user) => {
                const isSelf = user.id === currentUser.id;
                const isUpdating = updatingUserId === user.id;

                return (
                  <article
                    key={user.id}
                    className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm transition hover:border-zinc-300"
                  >
                    <div className="flex flex-col gap-4 border-b border-zinc-200 p-4 sm:p-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="break-words text-base font-bold text-zinc-900">
                            {user.name}
                          </h3>

                          {isSelf && (
                            <span className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700">
                              You
                            </span>
                          )}
                        </div>

                        <p className="mt-1 break-all font-mono text-xs text-zinc-500">
                          {user.email}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getRoleBadgeClasses(
                            user.role
                          )}`}
                        >
                          {user.role}
                        </span>

                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeClasses(
                            user.status
                          )}`}
                        >
                          {user.status}
                        </span>

                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${getApprovalBadgeClasses(
                            user.approvalStatus
                          )}`}
                        >
                          {user.approvalStatus}
                        </span>
                      </div>
                    </div>

                    <div className="grid gap-px bg-zinc-200 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="bg-zinc-50 p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          Registered
                        </p>

                        <p className="mt-1.5 text-xs text-zinc-800">
                          {formatDateTime(user.createdAt)}
                        </p>
                      </div>

                      <div className="bg-zinc-50 p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          Last Login
                        </p>

                        <p className="mt-1.5 text-xs text-zinc-800">
                          {formatDateTime(user.lastLoginAt)}
                        </p>
                      </div>

                      <div className="bg-zinc-50 p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          Registration IP
                        </p>

                        <p className="mt-1.5 break-all font-mono text-xs text-zinc-800">
                          {user.registrationIp || "Not recorded"}
                        </p>
                      </div>

                      <div className="bg-zinc-50 p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                          Approval Activity
                        </p>

                        <p className="mt-1.5 text-xs text-zinc-800">
                          {user.approvedAt
                            ? `Approved ${formatDateTime(
                                user.approvedAt
                              )}`
                            : user.rejectedAt
                              ? `Rejected ${formatDateTime(
                                  user.rejectedAt
                                )}`
                              : "Awaiting action"}
                        </p>
                      </div>
                    </div>

                    {user.rejectionReason && (
                      <div className="border-t border-rose-200 bg-rose-50 px-4 py-3 sm:px-5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-rose-800">
                          Rejection Reason
                        </p>

                        <p className="mt-1 break-words text-xs leading-5 text-rose-700">
                          {user.rejectionReason}
                        </p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 p-4 sm:px-5">
                      {user.approvalStatus !== "APPROVED" && (
                        <button
                          type="button"
                          disabled={isSelf || isUpdating}
                          onClick={() => handleApprove(user)}
                          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:border-zinc-300 disabled:text-zinc-400"
                        >
                          {isUpdating ? "Updating..." : "Approve"}
                        </button>
                      )}

                      {user.approvalStatus !== "REJECTED" && (
                        <button
                          type="button"
                          disabled={isSelf || isUpdating}
                          onClick={() => handleReject(user)}
                          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:border-zinc-300 disabled:text-zinc-400"
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
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:border-zinc-300 disabled:text-zinc-400"
                      >
                        {user.role === "ADMIN"
                          ? "Make User"
                          : "Make Admin"}
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
                        className={`rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:border-zinc-300 disabled:text-zinc-400 ${
                          user.status === "ACTIVE"
                            ? "border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-300"
                            : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:border-emerald-300"
                        }`}
                      >
                        {user.status === "ACTIVE"
                          ? "Suspend"
                          : "Reactivate"}
                      </button>
                    </div>
                  </article>
                );
              })}

              {filteredUsers.length === 0 && (
                <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-14 text-center">
                  <p className="text-sm font-semibold text-zinc-500">
                    No matching users found
                  </p>

                  <p className="mt-1 text-xs text-zinc-500">
                    Change the search term or approval filter.
                  </p>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}