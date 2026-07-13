"use client";

import React, { useState } from "react";
import Link from "next/link";

interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  createdAt: string;
}

export default function UserManagementClient({
  initialUsers,
  currentUser
}: {
  initialUsers: ManagedUser[];
  currentUser: { id: string; email: string; name: string; role: string };
}) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const handleUpdateUser = async (targetUserId: string, updates: { role?: string; status?: string }) => {
    setError(null);
    setUpdatingUserId(targetUserId);

    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId, ...updates })
      });

      const data = await res.json();

      if (res.ok) {
        setUsers(prev =>
          prev.map(u => (u.id === targetUserId ? { ...u, ...updates } : u))
        );
      } else {
        setError(data.error || "Failed to update user.");
      }
    } catch {
      setError("Network connection error. Try again.");
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/admin/login", { method: "DELETE" });
      if (res.ok) {
        window.location.href = "/login";
      }
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  return (
    <div className="flex flex-col flex-1 bg-zinc-950 text-zinc-100 font-sans min-h-screen">
      
      {/* Header Banner */}
      <div className="w-full bg-amber-500 text-zinc-950 text-center py-2 px-4 font-bold flex items-center justify-center gap-2 text-xs md:text-sm tracking-wide shadow-md">
        <span>ADMINISTRATOR PORTAL</span>
        <span className="font-normal border-l border-zinc-900 pl-2">
          Manage system access, roles, and suspension states.
        </span>
      </div>

      <div className="flex flex-1 flex-col md:flex-row">
        
        {/* Sidebar Panel */}
        <aside className="w-full md:w-64 bg-zinc-900 border-r border-zinc-800 p-6 flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-indigo-650 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-600/30">
              F
            </div>
            <div>
              <h1 className="font-semibold text-sm leading-tight text-white">FB Multi-Page</h1>
              <p className="text-[10px] text-zinc-500 font-mono">v1.0.0-phase2</p>
            </div>
          </div>

          <nav className="flex flex-col gap-1.5">
            <Link
              href="/"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
            >
              Overview Dashboard
            </Link>
            <Link
              href="/settings/meta-configuration"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
            >
              Meta Configuration
            </Link>
            <Link
              href="/admin/users"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium bg-zinc-800 text-white shadow-inner border border-zinc-700/50"
            >
              User Management
            </Link>
          </nav>

          {/* Profile & Logout Panel */}
          <div className="mt-auto border-t border-zinc-850 pt-4 flex flex-col gap-3">
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-zinc-250 truncate">{currentUser.name}</span>
              <span className="text-[10px] text-zinc-500 truncate mt-0.5">{currentUser.email}</span>
              <span className="text-[9px] text-indigo-400 font-mono tracking-wider uppercase mt-1 px-1.5 py-0.5 bg-indigo-950/40 border border-indigo-900/30 rounded w-fit">{currentUser.role}</span>
            </div>
            <button
              onClick={handleLogout}
              className="w-full text-center flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-zinc-900 hover:bg-rose-950/20 border border-zinc-800 hover:border-rose-900/30 text-rose-450 hover:text-rose-450 text-xs font-semibold transition"
            >
              Logout
            </button>
          </div>
        </aside>

        {/* Content Panel */}
        <main className="flex-1 flex flex-col bg-zinc-950 p-8">
          
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-bold text-white tracking-tight">User Management</h2>
              <p className="text-sm text-zinc-400">View and moderate publisher access controls for this workspace.</p>
            </div>
            <Link
              href="/register"
              className="bg-indigo-650 hover:bg-indigo-600 text-white font-semibold text-xs py-2 px-4 rounded-lg transition shadow shadow-indigo-600/10 border border-indigo-600/20"
            >
              Add New User
            </Link>
          </div>

          {error && (
            <div className="bg-rose-950/40 border border-rose-900/60 rounded-lg p-3 text-xs text-rose-450 font-semibold mb-6 flex items-center gap-2">
              <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Users Table */}
          <div className="bg-zinc-900/40 border border-zinc-800/80 backdrop-blur-md rounded-2xl shadow-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 text-xs font-mono uppercase text-zinc-500 tracking-wider">
                    <th className="px-6 py-4">Name</th>
                    <th className="px-6 py-4">Email</th>
                    <th className="px-6 py-4">Role</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Created At</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50 text-sm text-zinc-350">
                  {users.map(u => {
                    const isSelf = u.id === currentUser.id;
                    return (
                      <tr key={u.id} className="hover:bg-zinc-800/20 transition">
                        <td className="px-6 py-4 font-semibold text-zinc-200">
                          {u.name} {isSelf && <span className="text-[10px] font-mono text-indigo-400 ml-1.5 px-1 py-0.5 bg-indigo-950/40 border border-indigo-900/30 rounded">You</span>}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs">{u.email}</td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${
                            u.role === 'ADMIN' ? 'bg-indigo-950 text-indigo-400 border border-indigo-900/40' : 'bg-zinc-800 text-zinc-400'
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            u.status === 'ACTIVE' ? 'bg-emerald-950 text-emerald-450 border border-emerald-900/20' : 'bg-rose-950 text-rose-450 border border-rose-900/20'
                          }`}>
                            {u.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-zinc-500">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {/* Toggle Role Button */}
                            <button
                              disabled={isSelf || updatingUserId === u.id}
                              onClick={() => handleUpdateUser(u.id, { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' })}
                              className="text-xs font-semibold text-zinc-400 hover:text-zinc-200 border border-zinc-800 hover:border-zinc-700 disabled:text-zinc-600 disabled:border-transparent px-2.5 py-1.5 rounded transition bg-zinc-900/60"
                              title={isSelf ? "You cannot modify your own role" : "Change User Role"}
                            >
                              Toggle Role
                            </button>

                            {/* Suspend / Reactivate Button */}
                            <button
                              disabled={isSelf || updatingUserId === u.id}
                              onClick={() => handleUpdateUser(u.id, { status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })}
                              className={`text-xs font-semibold px-2.5 py-1.5 rounded transition border ${
                                u.status === 'ACTIVE'
                                  ? 'text-rose-400 hover:text-rose-350 bg-rose-950/20 border-rose-900/30 hover:border-rose-900/60 disabled:text-zinc-600 disabled:bg-transparent disabled:border-transparent'
                                  : 'text-emerald-400 hover:text-emerald-350 bg-emerald-950/20 border-emerald-900/30 hover:border-emerald-900/60 disabled:text-zinc-600 disabled:bg-transparent disabled:border-transparent'
                              }`}
                              title={isSelf ? "You cannot suspend yourself" : u.status === 'ACTIVE' ? "Suspend Account" : "Reactivate Account"}
                            >
                              {u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
