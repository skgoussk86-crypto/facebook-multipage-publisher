"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

interface ConnectionStatus {
  connected: boolean;
  googleAccountEmail: string | null;
  driveFolderId: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
  revokedAt: string | null;
  oauthConfigured: boolean;
  callbackUrl: string | null;
}

export default function StorageSettingsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const successParam = searchParams.get("success");
  const errorParam = searchParams.get("error");

  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [disconnectSuccess, setDisconnectSuccess] = useState(false);

  const successMessage = useMemo(() => {
    if (successParam === "google_drive_connected") {
      return "Google Drive storage account connected successfully!";
    }
    return null;
  }, [successParam]);

  const errorMessage = useMemo(() => {
    switch (errorParam) {
      case "google_oauth_not_configured":
        return "Google Drive OAuth client is not fully configured on the server.";
      case "google_oauth_state_invalid":
        return "CSRF verification failed: OAuth state is invalid or expired.";
      case "google_oauth_cancelled":
        return "Google OAuth connection process was cancelled or denied.";
      case "google_oauth_code_missing":
        return "No authorization code was returned by Google.";
      case "google_token_exchange_failed":
        return "Failed to exchange authorization code for tokens.";
      case "google_account_invalid":
        return "Google account verification failed. Please ensure the email is verified.";
      case "google_drive_folder_failed":
        return "Failed to find or create the dedicated Google Drive media folder.";
      case "google_refresh_token_missing":
        return "Connection failed: Google did not return a refresh token. Please disconnect the app in your Google Account security settings and try connecting again.";
      case "google_drive_connection_failed":
        return "An error occurred while saving the Google Drive connection to the database.";
      default:
        return null;
    }
  }, [errorParam]);

  const refreshStatus = useCallback(async () => {
    setIsRefreshing(true);
    setDisconnectError(null);
    setDisconnectSuccess(false);

    try {
      const res = await fetch("/api/google-drive/connection", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/login?callbackUrl=/settings/storage");
        router.refresh();
        return;
      }
      if (!res.ok) {
        throw new Error(`Failed to load status (status ${res.status})`);
      }
      const data = await res.json();
      setStatus(data);
    } catch (err: unknown) {
      console.error("Failed to refresh Google Drive connection status:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function initialLoad() {
      try {
        const res = await fetch("/api/google-drive/connection", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!active) return;

        if (res.status === 401) {
          router.replace("/login?callbackUrl=/settings/storage");
          router.refresh();
          return;
        }
        if (!res.ok) {
          throw new Error(`Failed to load status (status ${res.status})`);
        }
        const data = await res.json();
        if (active) {
          setStatus(data);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        console.error("Failed to load Google Drive connection status on mount:", err);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void initialLoad();

    return () => {
      active = false;
      controller.abort();
    };
  }, [router]);

  const handleDisconnect = async () => {
    if (!window.confirm("Are you sure you want to disconnect your Google Drive storage? This will revoke the application's access to your account.")) {
      return;
    }

    setIsDisconnecting(true);
    setDisconnectError(null);
    setDisconnectSuccess(false);

    try {
      const res = await fetch("/api/google-drive/connection", {
        method: "DELETE",
      });

      if (res.status === 401) {
        router.replace("/login?callbackUrl=/settings/storage");
        router.refresh();
        return;
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Disconnect failed with status ${res.status}`);
      }

      setDisconnectSuccess(true);
      router.replace("/settings/storage");
      await refreshStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDisconnectError(`Disconnect failed: ${msg}`);
    } finally {
      setIsDisconnecting(false);
    }
  };

  const isButtonsDisabled = isLoading || isRefreshing || isDisconnecting;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 font-sans text-zinc-300">
      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Sidebar */}
        <aside className="flex w-full shrink-0 flex-col gap-5 border-b border-zinc-800 bg-zinc-900 p-4 sm:p-6 lg:w-64 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-600/20">
              F
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight text-white">
                FB Multi-Page
              </h1>
              <p className="font-mono text-[10px] text-zinc-500">v1.0.0-phase4</p>
            </div>
          </div>

          <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex lg:flex-col">
            <Link
              href="/"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 lg:text-left lg:text-sm"
            >
              Overview
            </Link>
            <Link
              href="/#publisher"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 lg:text-left lg:text-sm"
            >
              Publisher
            </Link>
            <Link
              href="/#pages"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 lg:text-left lg:text-sm"
            >
              Synced Pages
            </Link>
            <Link
              href="/#logs"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 lg:text-left lg:text-sm"
            >
              Audit Logs
            </Link>
            <Link
              href="/settings/meta-configuration"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 lg:text-left lg:text-sm"
            >
              Meta Configuration
            </Link>
            <Link
              href="/settings/storage"
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-center text-xs font-medium text-white shadow-inner lg:text-left lg:text-sm"
            >
              Google Drive Storage
            </Link>
          </nav>
        </aside>

        {/* Main Content */}
        <main className="min-w-0 flex-1 space-y-7 overflow-y-auto bg-zinc-950 p-4 sm:p-6 lg:p-10">
          <header>
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
              Personal Settings
            </span>
            <h2 className="mt-1 text-2xl font-bold text-white">Google Drive Storage</h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">
              Connect and manage Google Drive storage integration. Decrypted tokens are never exposed to the browser or stored in plaintext.
            </p>
          </header>

          {/* Success and Error Alerts */}
          <section className="max-w-4xl space-y-3" aria-live="polite">
            {(successMessage || disconnectSuccess) && (
              <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/40 p-4 text-xs font-medium leading-relaxed text-emerald-400">
                <strong>Success:</strong> {successMessage || "Google Drive connection was disconnected successfully."}
              </div>
            )}

            {(errorMessage || disconnectError) && (
              <div className="rounded-xl border border-rose-900/50 bg-rose-950/40 p-4 text-xs font-medium leading-relaxed text-rose-400">
                <strong>Error:</strong> {errorMessage || disconnectError}
              </div>
            )}

            {status && !status.oauthConfigured && (
              <div className="rounded-xl border border-amber-900/50 bg-amber-950/40 p-4 text-xs font-medium leading-relaxed text-amber-400">
                <strong>Warning:</strong> Google Drive OAuth client is not fully configured on the server. Connect and Reconnect buttons are disabled. Check your environment settings.
              </div>
            )}
          </section>

          {/* Connection Status Panel */}
          {isLoading ? (
            <div className="py-12 max-w-4xl rounded-xl border border-zinc-800 bg-zinc-900 text-center font-mono text-xs text-zinc-500">
              Loading Google Drive configuration status...
            </div>
          ) : (
            <div className="max-w-4xl grid grid-cols-1 gap-6">
              <section className="min-w-0 space-y-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-md sm:p-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-zinc-800 pb-4 gap-3">
                  <h3 className="text-sm font-semibold text-white">Connection Status</h3>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Status:</span>
                    {status && status.connected ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border border-emerald-900/50 bg-emerald-950 text-emerald-400">
                        Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border border-rose-900/50 bg-rose-950 text-rose-400">
                        Disconnected
                      </span>
                    )}
                  </div>
                </div>

                {status && (
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <div className="space-y-1">
                      <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                        Google Account Email
                      </span>
                      <span className="block text-sm text-white break-all">
                        {status.googleAccountEmail || "Not Connected"}
                      </span>
                    </div>

                    <div className="space-y-1">
                      <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                        Dedicated Folder ID
                      </span>
                      <span className="block text-sm text-white break-all">
                        {status.driveFolderId || "Not Created"}
                      </span>
                    </div>

                    {status.connectedAt && (
                      <div className="space-y-1">
                        <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                          Connected At
                        </span>
                        <span className="block text-sm text-white">
                          {new Date(status.connectedAt).toLocaleString()}
                        </span>
                      </div>
                    )}

                    {status.updatedAt && (
                      <div className="space-y-1">
                        <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                          Last Updated
                        </span>
                        <span className="block text-sm text-white">
                          {new Date(status.updatedAt).toLocaleString()}
                        </span>
                      </div>
                    )}

                    {status.revokedAt && (
                      <div className="space-y-1">
                        <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                          Revoked At
                        </span>
                        <span className="block text-sm text-rose-400">
                          {new Date(status.revokedAt).toLocaleString()}
                        </span>
                      </div>
                    )}

                    <div className="space-y-1 md:col-span-2">
                      <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                        OAuth Configuration Status
                      </span>
                      <span className="block text-sm text-white">
                        {status.oauthConfigured ? "Fully Configured" : "Missing / Incomplete"}
                      </span>
                    </div>

                    <div className="space-y-2 md:col-span-2">
                      <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                        OAuth Callback URL
                      </span>
                      <span className="block rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-400 break-all select-all">
                        {status.callbackUrl || "Not Available (Check configuration)"}
                      </span>
                    </div>

                    <div className="space-y-1.5 md:col-span-2">
                      <span className="block font-mono text-[10px] font-medium uppercase text-zinc-500">
                        Requested Scope Permissions
                      </span>
                      <ul className="list-disc pl-5 text-xs text-zinc-400 space-y-1">
                        <li>openid</li>
                        <li>email</li>
                        <li className="break-all">https://www.googleapis.com/auth/drive.file</li>
                      </ul>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-6">
                  <div className="flex flex-wrap items-center gap-3">
                    {status && !status.connected ? (
                      <Link
                        href="/api/auth/google-drive/initiate"
                        aria-label="Connect Google Drive storage integration"
                        className={`inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-500 shadow-md ${
                          isButtonsDisabled || !status.oauthConfigured ? "pointer-events-none opacity-50" : ""
                        }`}
                      >
                        Connect Google Drive
                      </Link>
                    ) : (
                      <>
                        <Link
                          href="/api/auth/google-drive/initiate"
                          aria-label="Reconnect Google Drive storage integration"
                          className={`inline-flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-700 ${
                            isButtonsDisabled || (status && !status.oauthConfigured) ? "pointer-events-none opacity-50" : ""
                          }`}
                        >
                          Reconnect Google Drive
                        </Link>
                        <button
                          type="button"
                          onClick={handleDisconnect}
                          disabled={isButtonsDisabled}
                          aria-label="Disconnect Google Drive storage integration"
                          className="inline-flex items-center justify-center rounded-lg bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isDisconnecting ? "Disconnecting..." : "Disconnect Google Drive"}
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={refreshStatus}
                      disabled={isButtonsDisabled}
                      aria-label="Refresh storage integration status"
                      className="inline-flex items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isRefreshing ? "Refreshing..." : "Refresh Status"}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href="/settings/meta-configuration"
                      aria-label="Navigate to Meta configuration settings"
                      className={`inline-flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition ${
                        isButtonsDisabled ? "pointer-events-none opacity-50" : ""
                      }`}
                    >
                      Meta Configuration
                    </Link>

                    <Link
                      href="/"
                      aria-label="Navigate back to Dashboard"
                      className={`inline-flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition ${
                        isButtonsDisabled ? "pointer-events-none opacity-50" : ""
                      }`}
                    >
                      Back to Dashboard
                    </Link>
                  </div>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
