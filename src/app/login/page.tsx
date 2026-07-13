"use client";

import React, { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errorParam = searchParams.get("error");
  const [error, setError] = useState<string | null>(
    errorParam === "suspended"
      ? "This account has been suspended. Please contact the administrator."
      : null
  );
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoggingIn(true);

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      if (res.ok) {
        const callbackUrl = searchParams.get("callbackUrl") || "/";
        router.push(callbackUrl);
        router.refresh();
      } else {
        const err = await res.json();
        setError(err.error || "Invalid credentials. Try again.");
      }
    } catch {
      setError("Network connection error. Try again.");
    } finally {
      setIsLoggingIn(false);
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
            <p className="text-[10px] text-zinc-550 font-mono">Publisher Authentication Required</p>
          </div>
        </div>

        <h2 className="text-xl font-bold text-white mb-2">Sign in to your Account</h2>
        <p className="text-xs text-zinc-400 mb-6">Manage scheduled video, reel, and photo publications securely.</p>

        {error && (
          <div className="bg-rose-950/40 border border-rose-900/60 rounded-lg p-3 text-xs text-rose-450 font-semibold mb-5 flex items-center gap-2">
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
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
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={isLoggingIn}
            className="w-full bg-indigo-650 hover:bg-indigo-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-bold text-sm py-3 rounded-lg transition shadow-md shadow-indigo-600/20"
          >
            {isLoggingIn ? "Authenticating Session..." : "Log In Securely"}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-zinc-550 border-t border-zinc-850 pt-4">
          Need a publisher account?{" "}
          <Link href="/register" className="text-indigo-400 hover:text-indigo-350 font-semibold transition">
            Register Account
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center font-sans text-white">
        <span className="animate-spin h-8 w-8 border-4 border-indigo-650 border-t-transparent rounded-full"></span>
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
