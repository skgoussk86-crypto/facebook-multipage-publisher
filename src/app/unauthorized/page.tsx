"use client";

import React from "react";
import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center font-sans text-white px-4 text-center relative overflow-hidden">
      {/* Background radial glow */}
      <div className="absolute w-96 h-96 bg-rose-950/10 rounded-full blur-3xl animate-pulse"></div>

      <div className="relative z-10 max-w-md bg-zinc-900/40 border border-zinc-800/80 backdrop-blur-md p-8 rounded-2xl shadow-2xl flex flex-col items-center">
        <div className="h-16 w-16 rounded-full bg-rose-950/40 border border-rose-900/40 flex items-center justify-center text-rose-500 mb-6 shadow-lg">
          <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m0-6v2m0-5h.01M12 2a10 10 0 110 20 10 10 0 010-20z" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">403 - Forbidden</h1>
        <p className="text-zinc-400 text-sm mb-6">
          Access denied. Your publisher account role does not have the required administration privileges to view this section.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 w-full">
          <Link
            href="/"
            className="flex-1 bg-indigo-650 hover:bg-indigo-600 text-white text-xs font-semibold py-2.5 px-4 rounded-lg transition text-center shadow shadow-indigo-600/10 border border-indigo-600/20"
          >
            Overview Dashboard
          </Link>
          <button
            onClick={async () => {
              await fetch("/api/admin/login", { method: "DELETE" });
              window.location.href = "/login";
            }}
            className="flex-1 bg-zinc-900 hover:bg-zinc-850 text-zinc-300 text-xs font-semibold py-2.5 px-4 rounded-lg transition text-center border border-zinc-800"
          >
            Switch Account
          </button>
        </div>
      </div>
    </div>
  );
}
