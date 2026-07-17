"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface RegistrationResponse {
  success?: boolean;
  message?: string;
  error?: string;
}

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  const handleRegister = async (
    event: React.FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    setError(null);
    setSuccess(null);

    const cleanName = name.trim();
    const cleanEmail = email.trim();

    if (!cleanName) {
      setError("Full name is required.");
      return;
    }

    if (!cleanEmail) {
      setError("Email address is required.");
      return;
    }

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
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: cleanName,
          email: cleanEmail,
          password
        })
      });

      const data =
        (await response.json()) as RegistrationResponse;

      if (!response.ok) {
        setError(
          data.error || "Failed to register account."
        );
        return;
      }

      setSuccess(
        data.message ||
          "Registration successful. Your account is waiting for administrator approval."
      );

      setName("");
      setEmail("");
      setPassword("");
      setConfirmPassword("");

      window.setTimeout(() => {
        router.push("/login?registered=pending");
      }, 3000);
    } catch {
      setError("Network connection error. Try again.");
    } finally {
      setIsRegistering(false);
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
              Publisher Registration Console
            </p>
          </div>
        </div>

        <h2 className="mb-2 text-xl font-bold text-zinc-900">
          Create Publisher Account
        </h2>

        <p className="mb-3 text-xs text-zinc-500">
          Register your personal workspace for Facebook publishing.
        </p>

        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
          New accounts require administrator approval before they can
          log in and use the publisher.
        </div>

        {error && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
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

        {success && (
          <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold leading-5 text-emerald-800">
            <p>{success}</p>

            <p className="mt-2 font-normal text-emerald-600">
              Redirecting to the login page...
            </p>
          </div>
        )}

        <form
          onSubmit={handleRegister}
          className="space-y-4"
        >
          <div>
            <label className="mb-1.5 block font-mono text-xs uppercase text-zinc-500">
              Full Name
            </label>

            <input
              type="text"
              required
              disabled={isRegistering || Boolean(success)}
              value={name}
              onChange={(event) =>
                setName(event.target.value)
              }
              className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 transition placeholder-zinc-400 focus:border-indigo-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              placeholder="e.g. John Doe"
            />
          </div>

          <div>
            <label className="mb-1.5 block font-mono text-xs uppercase text-zinc-500">
              Email Address
            </label>

            <input
              type="email"
              required
              disabled={isRegistering || Boolean(success)}
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
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
              disabled={isRegistering || Boolean(success)}
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 transition placeholder-zinc-400 focus:border-indigo-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              placeholder="Minimum 12 characters"
            />
          </div>

          <div>
            <label className="mb-1.5 block font-mono text-xs uppercase text-zinc-500">
              Confirm Password
            </label>

            <input
              type="password"
              required
              disabled={isRegistering || Boolean(success)}
              value={confirmPassword}
              onChange={(event) =>
                setConfirmPassword(event.target.value)
              }
              className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 transition placeholder-zinc-400 focus:border-indigo-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
              placeholder="Re-enter password"
            />
          </div>

          <button
            type="submit"
            disabled={isRegistering || Boolean(success)}
            className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-bold text-white shadow-md shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
          >
            {isRegistering
              ? "Submitting Registration..."
              : success
                ? "Approval Pending"
                : "Register Profile"}
          </button>
        </form>

        <div className="mt-6 border-t border-zinc-200 pt-4 text-center text-xs text-zinc-500">
          Already have an approved account?{" "}

          <Link
            href="/login"
            className="font-semibold text-indigo-600 transition hover:text-indigo-500"
          >
            Log In Here
          </Link>
        </div>
      </div>
    </div>
  );
}