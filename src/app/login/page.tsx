"use client";

import React, { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

interface LoginResponse {
  success?: boolean;
  email?: string;
  error?: string;
  setupRequired?: boolean;
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const registeredStatus = searchParams.get("registered");
  const errorParam = searchParams.get("error");

  const initialError =
    errorParam === "suspended"
      ? "This account has been suspended. Please contact the administrator."
      : errorParam === "pending"
        ? "Your account is waiting for administrator approval."
        : errorParam === "rejected"
          ? "Your registration was rejected by the administrator."
          : null;

  const initialNotice =
    registeredStatus === "pending"
      ? "Registration successful. Your account is waiting for administrator approval. You can log in after an administrator approves it."
      : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState<string | null>(
    initialError
  );

  const [notice] = useState<string | null>(
    initialNotice
  );

  const [isLoggingIn, setIsLoggingIn] =
    useState(false);

  const handleLogin = async (
    event: React.FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    setError(null);
    setIsLoggingIn(true);

    try {
      const response = await fetch(
        "/api/admin/login",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email: email.trim(),
            password
          })
        }
      );

      const data =
        (await response.json()) as LoginResponse;

      if (!response.ok) {
        setError(
          data.error ||
            "Unable to log in. Please check your credentials."
        );
        return;
      }

      const callbackUrl =
        searchParams.get("callbackUrl") || "/";

      router.push(callbackUrl);
      router.refresh();
    } catch {
      setError(
        "Network connection error. Try again."
      );
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-zinc-50 px-4 font-sans text-zinc-900">
      <div className="absolute left-1/4 top-1/4 h-96 w-96 animate-pulse rounded-full bg-indigo-900/5 blur-3xl" />

      <div className="absolute bottom-1/4 right-1/4 h-96 w-96 animate-pulse rounded-full bg-purple-900/5 blur-3xl" />

      <div className="relative z-10 flex w-full max-w-md flex-col rounded-2xl border border-zinc-200 bg-white p-8 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-600/30">
            F
          </div>

          <div>
            <h1 className="text-sm font-semibold leading-tight text-zinc-900">
              FB Multi-Page
            </h1>

            <p className="font-mono text-[10px] text-zinc-500">
              Publisher Authentication Required
            </p>
          </div>
        </div>

        <h2 className="mb-2 text-xl font-bold text-zinc-900">
          Sign in to Your Account
        </h2>

        <p className="mb-6 text-xs text-zinc-500">
          Manage scheduled videos, reels and photo publications securely.
        </p>

        {notice && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs font-semibold leading-5 text-amber-800">
            {notice}
          </div>
        )}

        {error && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-semibold leading-5 text-rose-800">
            <svg
              className="h-4 w-4 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>

            <span>{error}</span>
          </div>
        )}

        <form
          onSubmit={handleLogin}
          className="space-y-4"
        >
          <div>
            <label className="mb-1.5 block font-mono text-xs uppercase text-zinc-500">
              Email Address
            </label>

            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              disabled={isLoggingIn}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 transition placeholder-zinc-400 focus:border-indigo-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              placeholder="e.g. user@domain.com"
            />
          </div>

          <div>
            <label className="mb-1.5 block font-mono text-xs uppercase text-zinc-500">
              Password
            </label>

            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              disabled={isLoggingIn}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 transition placeholder-zinc-400 focus:border-indigo-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            disabled={isLoggingIn}
            className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-bold text-white shadow-md shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
          >
            {isLoggingIn
              ? "Authenticating Session..."
              : "Log In Securely"}
          </button>
        </form>

        <div className="mt-6 border-t border-zinc-200 pt-4 text-center text-xs text-zinc-500">
          Need a publisher account?{" "}

          <Link
            href="/register"
            className="font-semibold text-indigo-600 transition hover:text-indigo-500"
          >
            Register Account
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans text-zinc-900">
          <span className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}