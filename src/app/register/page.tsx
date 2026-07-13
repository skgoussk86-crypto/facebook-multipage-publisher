"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (password.length < 12) {
      setError("Password must be at least 12 characters long.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsRegistering(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password })
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess("Account registered successfully! Redirecting to login...");
        setTimeout(() => {
          router.push("/login");
        }, 1500);
      } else {
        setError(data.error || "Failed to register account.");
      }
    } catch {
      setError("Network connection error. Try again.");
    } finally {
      setIsRegistering(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center font-sans text-white px-4 relative overflow-hidden">
      {/* Sleek animated background gradient blobs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-900/10 rounded-full blur-3xl animate-pulse"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-900/10 rounded-full blur-3xl animate-pulse delay-700"></div>

      <div className="bg-zinc-900/40 border border-zinc-800/80 backdrop-blur-md rounded-2xl w-full max-w-md p-8 shadow-2xl flex flex-col relative z-10">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-9 w-9 rounded-lg bg-indigo-650 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-600/30">
            F
          </div>
          <div>
            <h1 className="font-semibold text-sm leading-tight text-white">FB Multi-Page</h1>
            <p className="text-[10px] text-zinc-550 font-mono">Publisher Registration Console</p>
          </div>
        </div>

        <h2 className="text-xl font-bold text-white mb-2">Create Publisher Account</h2>
        <p className="text-xs text-zinc-400 mb-6">Create a personal workspace to configure pages and schedule uploads.</p>

        {error && (
          <div className="bg-rose-950/40 border border-rose-900/60 rounded-lg p-3 text-xs text-rose-450 font-semibold mb-5 flex items-center gap-2 animate-shake">
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="bg-emerald-950/40 border border-emerald-900/60 rounded-lg p-3 text-xs text-emerald-400 font-semibold mb-5 flex items-center gap-2">
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{success}</span>
          </div>
        )}

        <form onSubmit={handleRegister} className="space-y-4">
          <div>
            <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase">Full Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-650 transition font-sans"
              placeholder="e.g. John Doe"
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase">Email Address</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-650 transition font-sans"
              placeholder="e.g. user@domain.com"
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-650 transition"
              placeholder="Minimum 12 characters"
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase">Confirm Password</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-650 transition"
              placeholder="Re-enter password"
            />
          </div>

          <button
            type="submit"
            disabled={isRegistering}
            className="w-full bg-indigo-650 hover:bg-indigo-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-bold text-sm py-3 rounded-lg transition shadow-md shadow-indigo-600/20"
          >
            {isRegistering ? "Creating Workspace..." : "Register Profile"}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-zinc-550 border-t border-zinc-850 pt-4">
          Already have an account?{" "}
          <Link href="/login" className="text-indigo-400 hover:text-indigo-350 font-semibold transition">
            Log In Here
          </Link>
        </div>
      </div>
    </div>
  );
}
