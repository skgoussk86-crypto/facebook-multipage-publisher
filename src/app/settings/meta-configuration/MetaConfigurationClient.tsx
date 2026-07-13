"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type ConnectionState =
  | "Connected"
  | "Token Expiring"
  | "Reconnection Required"
  | "Permission Missing";

interface FacebookPage {
  id: string;
  name: string;
  category: string;
  pictureUrl: string;
  tokenStatus: "Valid" | "Expired";
  connectedAt: string;
}

interface FacebookAccountUI {
  id: string;
  facebookUserId: string;
  name: string;
  tokenExpiresAt: string;
  connectionState: ConnectionState;
  pages: FacebookPage[];
}

interface MetaConfigurationClientProps {
  adminEmail: string;
}

interface TestResult {
  success: boolean;
  message: string;
  details?: unknown;
}

interface SaveResult {
  success: boolean;
  message: string;
}

interface ConfigurationResponse {
  publicAppUrl?: string;
  facebookAppId?: string;
  facebookAppSecret?: string;
  liveMetaMode?: boolean;
  success?: boolean;
  error?: string;
  config?: {
    publicAppUrl: string;
    facebookAppId: string;
    facebookAppSecret: string;
    liveMetaMode: boolean;
  };
}

const FACEBOOK_SECRET_MASK = "************";

function formatExpiryDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleDateString();
}

function getConnectionStateClasses(
  state: ConnectionState
): string {
  if (state === "Connected") {
    return "border-emerald-900/50 bg-emerald-950 text-emerald-400";
  }

  if (state === "Token Expiring") {
    return "border-amber-900/50 bg-amber-950 text-amber-400";
  }

  return "border-rose-900/50 bg-rose-950 text-rose-400";
}

export default function MetaConfigurationClient({
  adminEmail
}: MetaConfigurationClientProps) {
  const router = useRouter();

  const userEmail = adminEmail;

  const [publicAppUrl, setPublicAppUrl] = useState("");
  const [facebookAppId, setFacebookAppId] =
    useState("");
  const [facebookAppSecret, setFacebookAppSecret] =
    useState("");
  const [liveMetaMode, setLiveMetaMode] =
    useState(false);

  const [accounts, setAccounts] = useState<
    FacebookAccountUI[]
  >([]);
  const [isLoadingConfig, setIsLoadingConfig] =
    useState(true);
  const [isLoadingAccounts, setIsLoadingAccounts] =
    useState(false);
  const [accountLoadError, setAccountLoadError] =
    useState("");

  const [testResult, setTestResult] =
    useState<TestResult | null>(null);
  const [saveResult, setSaveResult] =
    useState<SaveResult | null>(null);

  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [copyStatus, setCopyStatus] = useState<
    "idle" | "copied" | "failed"
  >("idle");

  const handleUnauthorized = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const loadConnectedAccounts =
    useCallback(async () => {
      setIsLoadingAccounts(true);
      setAccountLoadError("");

      try {
        const response = await fetch(
          "/api/facebook/pages",
          {
            cache: "no-store"
          }
        );

        if (response.status === 401) {
          handleUnauthorized();
          return;
        }

        if (!response.ok) {
          throw new Error(
            `Account request failed with status ${response.status}`
          );
        }

        const data = (await response.json()) as {
          accounts?: FacebookAccountUI[];
        };

        setAccounts(
          Array.isArray(data.accounts)
            ? data.accounts
            : []
        );
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          "Failed to load connected accounts:",
          error
        );

        setAccountLoadError(
          `Unable to load connected accounts: ${message}`
        );
      } finally {
        setIsLoadingAccounts(false);
      }
    }, [handleUnauthorized]);

  const loadConfiguration = useCallback(async () => {
    setIsLoadingConfig(true);

    try {
      const response = await fetch(
        "/api/admin/config",
        {
          cache: "no-store"
        }
      );

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!response.ok) {
        throw new Error(
          `Configuration request failed with status ${response.status}`
        );
      }

      const data =
        (await response.json()) as ConfigurationResponse;

      setPublicAppUrl(data.publicAppUrl ?? "");
      setFacebookAppId(data.facebookAppId ?? "");
      setFacebookAppSecret(
        data.facebookAppSecret ?? ""
      );
      setLiveMetaMode(data.liveMetaMode === true);

      await loadConnectedAccounts();
    } catch (error) {
      console.error(
        "Meta configuration load failed:",
        error
      );

      setSaveResult({
        success: false,
        message:
          "Unable to load your Meta configuration."
      });
    } finally {
      setIsLoadingConfig(false);
    }
  }, [
    handleUnauthorized,
    loadConnectedAccounts
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfiguration();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [loadConfiguration]);

  const sanitizedPublicAppUrl = useMemo(
    () => publicAppUrl.trim().replace(/\/+$/, ""),
    [publicAppUrl]
  );

  const computedCallbackUrl =
    sanitizedPublicAppUrl.length > 0
      ? `${sanitizedPublicAppUrl}/api/auth/facebook/callback`
      : "";

  const hostnameWarning = useMemo(() => {
    if (
      !publicAppUrl ||
      typeof window === "undefined"
    ) {
      return null;
    }

    try {
      const configuredUrl = new URL(publicAppUrl);
      const currentHost = window.location.host;

      if (configuredUrl.host !== currentHost) {
        return `The configured host (${configuredUrl.host}) does not match the current browser host (${currentHost}). Open the application through the configured Public App URL before starting Facebook OAuth.`;
      }

      return null;
    } catch {
      return "The configured Public App URL is not a valid URL.";
    }
  }, [publicAppUrl]);

  const isConfigurationIncomplete =
    !publicAppUrl.trim() ||
    !facebookAppId.trim() ||
    !facebookAppSecret.trim();

  const handleLogout = async () => {
    try {
      await fetch("/api/admin/login", {
        method: "DELETE"
      });
    } catch (error) {
      console.error("Logout request failed:", error);
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  const handleCopyCallback = async () => {
    if (!computedCallbackUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        computedCallbackUrl
      );

      setCopyStatus("copied");
    } catch (error) {
      console.error(
        "Callback URL copy failed:",
        error
      );

      setCopyStatus("failed");
    }

    window.setTimeout(() => {
      setCopyStatus("idle");
    }, 2000);
  };

  const handleTestConfiguration = async () => {
    setTestResult(null);
    setSaveResult(null);
    setIsTesting(true);

    try {
      const response = await fetch(
        "/api/admin/config/test",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            publicAppUrl,
            facebookAppId,
            facebookAppSecret,
            liveMetaMode
          })
        }
      );

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      const data =
        (await response.json()) as TestResult;

      setTestResult({
        success:
          response.ok && data.success === true,
        message:
          data.message ||
          "No validation response was returned.",
        details: data.details
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      setTestResult({
        success: false,
        message:
          `Network error during local validation: ${message}`
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveConfiguration = async () => {
    setSaveResult(null);
    setTestResult(null);
    setIsSaving(true);

    try {
      const response = await fetch(
        "/api/admin/config",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            publicAppUrl,
            facebookAppId,
            facebookAppSecret,
            liveMetaMode
          })
        }
      );

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      const data =
        (await response.json()) as ConfigurationResponse;

      if (
        response.ok &&
        data.success &&
        data.config
      ) {
        setPublicAppUrl(
          data.config.publicAppUrl
        );
        setFacebookAppId(
          data.config.facebookAppId
        );
        setFacebookAppSecret(
          data.config.facebookAppSecret ||
            FACEBOOK_SECRET_MASK
        );
        setLiveMetaMode(
          data.config.liveMetaMode
        );

        setSaveResult({
          success: true,
          message:
            "Your personal Meta configuration was saved securely."
        });

        return;
      }

      setSaveResult({
        success: false,
        message:
          data.error ||
          "Unable to save the configuration."
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      setSaveResult({
        success: false,
        message:
          `Network error while saving configuration: ${message}`
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 font-sans text-zinc-300">
      <div
        className={`flex w-full flex-col items-center justify-center gap-1 px-4 py-2 text-center text-xs font-bold tracking-wide text-zinc-950 shadow-md transition-colors sm:flex-row sm:gap-2 sm:text-sm ${
          liveMetaMode
            ? "bg-emerald-500"
            : "bg-amber-500"
        }`}
      >
        <span className="relative flex h-3 w-3 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-zinc-900 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-zinc-950" />
        </span>

        <span>
          {liveMetaMode
            ? "LIVE META API MODE ACTIVE"
            : "MOCK META MODE ACTIVE"}
        </span>

        <span className="font-normal sm:border-l sm:border-zinc-900 sm:pl-2">
          {liveMetaMode
            ? "Real Meta API requests are enabled for your account."
            : "Facebook login and publishing are currently simulated."}
        </span>
      </div>

      <div className="flex flex-1 flex-col lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col gap-5 border-b border-zinc-800 bg-zinc-900 p-4 sm:p-6 lg:w-64 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-600/20">
              F
            </div>

            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight text-white">
                FB Multi-Page
              </h1>

              <p className="font-mono text-[10px] text-zinc-500">
                v1.0.0-phase2
              </p>
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
              className="col-span-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-center text-xs font-medium text-white shadow-inner sm:col-span-4 lg:col-span-1 lg:text-left lg:text-sm"
            >
              Meta Configuration
            </Link>
          </nav>

          <div className="border-t border-zinc-800 pt-4 lg:mt-auto lg:pt-6">
            <p className="text-[10px] uppercase tracking-wide text-zinc-600">
              Signed in as
            </p>

            <p className="mt-1 truncate text-xs text-zinc-400">
              {userEmail}
            </p>

            <button
              type="button"
              onClick={handleLogout}
              className="mt-3 text-left text-xs font-semibold text-rose-400 transition hover:text-rose-300"
            >
              Log Out
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 space-y-7 overflow-y-auto bg-zinc-950 p-4 sm:p-6 lg:p-10">
          <header>
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
              Personal Settings
            </span>

            <h2 className="mt-1 text-2xl font-bold text-white">
              Meta Configuration
            </h2>

            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">
              Configure the Meta credentials and
              callback URL used only by your account.
              Secrets are encrypted before they are
              stored.
            </p>
          </header>

          <section className="max-w-4xl space-y-3">
            {isConfigurationIncomplete && (
              <div className="rounded-xl border border-rose-900/50 bg-rose-950/40 p-4 text-xs font-medium leading-relaxed text-rose-400">
                <strong>
                  Configuration incomplete:
                </strong>{" "}
                Enter the Public Application URL,
                Facebook App ID and Facebook App Secret.
              </div>
            )}

            {publicAppUrl.includes(
              "trycloudflare.com"
            ) && (
              <div className="rounded-xl border border-amber-900/50 bg-amber-950/40 p-4 text-xs font-medium leading-relaxed text-amber-400">
                <strong>
                  Temporary tunnel detected:
                </strong>{" "}
                A trycloudflare.com URL may change. Use
                your permanent custom domain for
                production.
              </div>
            )}

            {hostnameWarning && (
              <div className="rounded-xl border border-amber-900/50 bg-amber-950/40 p-4 text-xs font-medium leading-relaxed text-amber-400">
                <strong>
                  Hostname warning:
                </strong>{" "}
                {hostnameWarning}
              </div>
            )}
          </section>

          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-3">
            <section className="min-w-0 space-y-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-md sm:p-6 xl:col-span-2">
              <h3 className="border-b border-zinc-800 pb-3 text-sm font-semibold text-white">
                Application Settings
              </h3>

              {isLoadingConfig ? (
                <div className="py-12 text-center font-mono text-xs text-zinc-500">
                  Loading your configuration...
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label
                      htmlFor="public-app-url"
                      className="mb-1.5 block font-mono text-xs font-medium uppercase text-zinc-400"
                    >
                      Public Application URL
                    </label>

                    <input
                      id="public-app-url"
                      type="url"
                      value={publicAppUrl}
                      onChange={(event) =>
                        setPublicAppUrl(
                          event.target.value
                        )
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-indigo-600"
                      placeholder="https://your-domain.com"
                      autoComplete="url"
                    />

                    <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                      Use the externally accessible base
                      URL. HTTPS is required in Live Meta
                      Mode.
                    </p>
                  </div>

                  <div className="min-w-0">
                    <label
                      htmlFor="facebook-app-id"
                      className="mb-1.5 block font-mono text-xs font-medium uppercase text-zinc-400"
                    >
                      Facebook App ID
                    </label>

                    <input
                      id="facebook-app-id"
                      type="text"
                      value={facebookAppId}
                      onChange={(event) =>
                        setFacebookAppId(
                          event.target.value
                        )
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 font-mono text-sm text-white outline-none transition focus:border-indigo-600"
                      placeholder="Enter your Facebook App ID"
                      autoComplete="off"
                    />

                    <p className="mt-1 text-[10px] text-zinc-500">
                      App identifier from the Meta
                      developer dashboard.
                    </p>
                  </div>

                  <div className="min-w-0">
                    <label
                      htmlFor="facebook-app-secret"
                      className="mb-1.5 block font-mono text-xs font-medium uppercase text-zinc-400"
                    >
                      Facebook App Secret
                    </label>

                    <input
                      id="facebook-app-secret"
                      type="password"
                      value={facebookAppSecret}
                      onChange={(event) =>
                        setFacebookAppSecret(
                          event.target.value
                        )
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-indigo-600"
                      placeholder={FACEBOOK_SECRET_MASK}
                      autoComplete="new-password"
                    />

                    <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                      Keep the masked value unchanged to
                      preserve your currently encrypted
                      secret.
                    </p>
                  </div>

                  <div className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:flex-row sm:items-center sm:justify-between md:col-span-2">
                    <div className="space-y-1">
                      <span className="block text-xs font-bold text-white">
                        Live Meta API Mode
                      </span>

                      <span className="block max-w-lg text-[10px] leading-relaxed text-zinc-500">
                        Enable real Facebook OAuth and
                        Graph API requests. Leave disabled
                        while testing with the local
                        simulator.
                      </span>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={liveMetaMode}
                      onClick={() =>
                        setLiveMetaMode(
                          (current) => !current
                        )
                      }
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                        liveMetaMode
                          ? "bg-indigo-600"
                          : "bg-zinc-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          liveMetaMode
                            ? "translate-x-6"
                            : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <label
                      htmlFor="callback-url"
                      className="block font-mono text-xs font-medium uppercase text-zinc-400"
                    >
                      OAuth Callback URL
                    </label>

                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                      <input
                        id="callback-url"
                        type="text"
                        readOnly
                        value={
                          computedCallbackUrl ||
                          "Awaiting Public App URL..."
                        }
                        className="min-w-0 flex-1 select-all rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 font-mono text-xs text-zinc-400 outline-none"
                      />

                      <button
                        type="button"
                        onClick={
                          handleCopyCallback
                        }
                        disabled={
                          !computedCallbackUrl
                        }
                        className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {copyStatus === "copied"
                          ? "Copied"
                          : copyStatus === "failed"
                            ? "Copy Failed"
                            : "Copy URL"}
                      </button>
                    </div>

                    <p className="text-[10px] leading-relaxed text-zinc-500">
                      Add this exact URL in Meta Developer
                      Dashboard &gt; Facebook Login &gt;
                      Settings &gt; Valid OAuth Redirect
                      URIs.
                    </p>
                  </div>
                </div>
              )}

              {testResult && (
                <div
                  className={`rounded-xl border p-4 font-mono text-xs ${
                    testResult.success
                      ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-400"
                      : "border-rose-900/60 bg-rose-950/40 text-rose-400"
                  }`}
                >
                  <p className="mb-1 text-sm font-bold">
                    {testResult.success
                      ? "Local Validation Passed"
                      : "Validation Failed"}
                  </p>

                  <p>{testResult.message}</p>

                  {testResult.details !== undefined && (
                    <pre className="mt-3 overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-300">
                      {JSON.stringify(
                        testResult.details,
                        null,
                        2
                      )}
                    </pre>
                  )}
                </div>
              )}

              {saveResult && (
                <div
                  className={`rounded-xl border p-4 text-xs font-semibold ${
                    saveResult.success
                      ? "border-indigo-900/60 bg-indigo-950/40 text-indigo-400"
                      : "border-rose-900/60 bg-rose-950/40 text-rose-400"
                  }`}
                >
                  {saveResult.message}
                </div>
              )}

              <div className="flex flex-col gap-3 border-t border-zinc-800 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  onClick={
                    handleTestConfiguration
                  }
                  disabled={
                    isTesting ||
                    isSaving ||
                    isLoadingConfig
                  }
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isTesting
                    ? "Validating..."
                    : "Validate Configuration"}
                </button>

                <button
                  type="button"
                  onClick={
                    handleSaveConfiguration
                  }
                  disabled={
                    isSaving ||
                    isTesting ||
                    isLoadingConfig
                  }
                  className="rounded-lg bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving
                    ? "Saving..."
                    : "Save Securely"}
                </button>
              </div>
            </section>

            <div className="min-w-0 space-y-6">
              <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-md sm:p-6">
                <h3 className="border-b border-zinc-800 pb-3 text-sm font-semibold text-white">
                  Facebook Authorization
                </h3>

                <p className="text-xs leading-relaxed text-zinc-400">
                  Start Facebook OAuth to connect a Meta
                  profile to your own application account.
                  Access tokens are encrypted on the
                  server.
                </p>

                <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-[10px] text-zinc-500">
                  <p className="text-[9px] font-bold uppercase tracking-wide text-white">
                    Requested OAuth Permissions
                  </p>

                  {[
                    "pages_show_list",
                    "pages_read_engagement",
                    "pages_manage_posts"
                  ].map((permission) => (
                    <div
                      key={permission}
                      className="flex items-center gap-2 text-emerald-400"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      {permission}
                    </div>
                  ))}
                </div>

                <a
                  href="/api/auth/facebook/initiate"
                  className="block w-full rounded-lg border border-zinc-700 bg-zinc-800 py-3 text-center text-xs font-bold text-white shadow transition hover:bg-zinc-700"
                >
                  {accounts.length > 0
                    ? "Add Another Facebook Account"
                    : "Connect Facebook Account"}
                </a>
              </section>

              <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-md sm:p-6">
                <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3">
                  <h3 className="text-sm font-semibold text-white">
                    Connected Meta Accounts
                  </h3>

                  <button
                    type="button"
                    onClick={() =>
                      void loadConnectedAccounts()
                    }
                    disabled={isLoadingAccounts}
                    className="text-[10px] font-semibold text-indigo-400 transition hover:text-indigo-300 disabled:opacity-50"
                  >
                    Refresh
                  </button>
                </div>

                {accountLoadError && (
                  <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 p-3 text-xs text-rose-400">
                    {accountLoadError}
                  </div>
                )}

                {isLoadingAccounts ? (
                  <div className="py-6 text-center font-mono text-xs text-zinc-500">
                    Loading account details...
                  </div>
                ) : accounts.length === 0 ? (
                  <p className="py-4 text-center text-xs italic text-zinc-500">
                    No Facebook account is linked to your
                    user account.
                  </p>
                ) : (
                  <div className="max-h-[360px] space-y-4 overflow-y-auto pr-1">
                    {accounts.map((account) => (
                      <article
                        key={account.id}
                        className="min-w-0 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3.5"
                      >
                        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <span className="min-w-0 truncate text-xs font-bold text-white">
                            {account.name}
                          </span>

                          <span
                            className={`w-fit shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${getConnectionStateClasses(
                              account.connectionState
                            )}`}
                          >
                            {account.connectionState}
                          </span>
                        </div>

                        <div className="space-y-1 break-words font-mono text-[10px] text-zinc-500">
                          <div>
                            Facebook ID:{" "}
                            {account.facebookUserId}
                          </div>

                          <div>
                            Token expires:{" "}
                            {formatExpiryDate(
                              account.tokenExpiresAt
                            )}
                          </div>

                          <div>
                            Pages synced:{" "}
                            {account.pages?.length ?? 0}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}