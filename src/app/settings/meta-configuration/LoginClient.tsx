"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginClient() {
  const router = useRouter();
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setIsLoggingIn(true);

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      });

      if (res.ok) {
        // Successful login: Refresh the server component state
        router.refresh();
      } else {
        const err = await res.json();
        setLoginError(err.error || "Invalid credentials. Try again.");
      }
    } catch {
      setLoginError("Network connection error. Try again.");
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
          <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg">
            F
          </div>
          <div>
            <h1 className="font-semibold text-sm leading-tight text-white">FB Multi-Page</h1>
            <p className="text-[10px] text-zinc-500 font-mono">Administrator Session Required</p>
          </div>
        </div>

        <h2 className="text-xl font-bold text-white mb-2">Sign in as Administrator</h2>
        <p className="text-xs text-zinc-400 mb-6">Access secure setup configurations for the Facebook Multi-Page Publisher.</p>

        {loginError && (
          <div className="bg-rose-950/40 border border-rose-900/60 rounded-lg p-3 text-xs text-rose-400 font-semibold mb-5 flex items-center gap-2">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            {loginError}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase">Admin Email</label>
            <input
              type="email"
              required
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono transition"
              placeholder="e.g. admin@domain.com"
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase">Admin Password</label>
            <input
              type="password"
              required
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={isLoggingIn}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white font-bold text-sm py-3 rounded-lg transition shadow-md shadow-indigo-600/20"
          >
            {isLoggingIn ? "Authenticating Session..." : "Log In Securely"}
          </button>
        </form>
      </div>
    </div>
  );
}
