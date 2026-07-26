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
  facebookPageId: string;
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
  appConfigurationId?: string;
  configurationName?: string;
  facebookAppId?: string;
  liveMetaMode?: boolean;
  isDefault?: boolean;
}

interface AppConfigurationUI {
  id: string;
  configurationName: string;
  publicAppUrl: string;
  facebookAppId: string;
  liveMetaMode: boolean;
  isDefault: boolean;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  secretConfigured: boolean;
  accountCount: number;
  pageCount: number;
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

const FACEBOOK_SECRET_MASK = "************";

function formatExpiryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleDateString();
}

function getConnectionStateClasses(state: ConnectionState): string {
  if (state === "Connected") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (state === "Token Expiring") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  return "border-rose-200 bg-rose-50 text-rose-700";
}

export default function MetaConfigurationClient({
  adminEmail
}: MetaConfigurationClientProps) {
  const router = useRouter();

  // App Configurations & Accounts lists state
  const [configurations, setConfigurations] = useState<AppConfigurationUI[]>([]);
  const [accounts, setAccounts] = useState<FacebookAccountUI[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string>("");

  // Editor states
  const [formConfigName, setFormConfigName] = useState("");
  const [formPublicAppUrl, setFormPublicAppUrl] = useState("");
  const [formFacebookAppId, setFormFacebookAppId] = useState("");
  const [formFacebookAppSecret, setFormFacebookAppSecret] = useState("");
  const [formLiveMetaMode, setFormLiveMetaMode] = useState(false);
  const [formIsEnabled, setFormIsEnabled] = useState(true);

  // Status/Loading States
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSyncing, setIsSyncing] = useState<Record<string, boolean>>({});
  const [isDisconnecting, setIsDisconnecting] = useState<Record<string, boolean>>({});

  const [errorMsg, setErrorMsg] = useState("");
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const handleUnauthorized = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const selectedConfigObject = useMemo(() => {
    return configurations.find((c) => c.id === selectedConfigId) || null;
  }, [configurations, selectedConfigId]);

  // Populate Editor fields
  const applyConfigurationToForm = useCallback((config: AppConfigurationUI | "new") => {
    if (config === "new") {
      setFormConfigName("New Meta App");
      setFormPublicAppUrl(typeof window !== "undefined" ? window.location.origin : "");
      setFormFacebookAppId("");
      setFormFacebookAppSecret("");
      setFormLiveMetaMode(false);
      setFormIsEnabled(true);
    } else {
      setFormConfigName(config.configurationName);
      setFormPublicAppUrl(config.publicAppUrl);
      setFormFacebookAppId(config.facebookAppId);
      setFormFacebookAppSecret(config.secretConfigured ? FACEBOOK_SECRET_MASK : "");
      setFormLiveMetaMode(config.liveMetaMode);
      setFormIsEnabled(config.isEnabled);
    }
  }, []);

  // Load Configurations and Accounts
  const loadData = useCallback(async (preferredConfigurationId?: string) => {
    setIsLoading(true);
    setErrorMsg("");
    try {
      const [configsRes, pagesRes] = await Promise.all([
        fetch("/api/admin/configurations", { cache: "no-store" }),
        fetch("/api/facebook/pages", { cache: "no-store" })
      ]);

      if (configsRes.status === 401 || pagesRes.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!configsRes.ok || !pagesRes.ok) {
        throw new Error("Failed to retrieve server configurations or connections.");
      }

      const configsData = (await configsRes.json()) as AppConfigurationUI[];
      const pagesData = (await pagesRes.json()) as { accounts: FacebookAccountUI[] };

      setConfigurations(configsData);
      setAccounts(pagesData.accounts || []);

      // Resolve which configuration to select
      let activeConfig: AppConfigurationUI | "new" = "new";
      let activeSelectId = preferredConfigurationId;
      if (!activeSelectId) {
        const def = configsData.find((c) => c.isDefault);
        if (def) {
          activeSelectId = def.id;
        } else if (configsData.length > 0) {
          activeSelectId = configsData[0].id;
        } else {
          activeSelectId = "new";
        }
      }

      if (activeSelectId !== "new") {
        const found = configsData.find((c) => c.id === activeSelectId);
        if (found) {
          activeConfig = found;
        } else {
          const def = configsData.find((c) => c.isDefault);
          if (def) {
            activeConfig = def;
            activeSelectId = def.id;
          } else if (configsData.length > 0) {
            activeConfig = configsData[0];
            activeSelectId = configsData[0].id;
          } else {
            activeConfig = "new";
            activeSelectId = "new";
          }
        }
      }

      setSelectedConfigId(activeSelectId);
      applyConfigurationToForm(activeConfig);

    } catch (error: unknown) {
      console.error("Data load failed:", error);
      setErrorMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [handleUnauthorized, applyConfigurationToForm]);

  // Coordinated initialization effect that runs once on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const success = params.get("success");
      const error = params.get("error");
      const configId = params.get("configurationId");

      if (success || error) {
        window.history.replaceState({}, "", window.location.pathname);

        const cleanSuccess = success || undefined;
        const cleanError = error || undefined;
        const cleanConfigId = configId || undefined;

        if (cleanSuccess) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSaveResult({
            success: true,
            message: cleanSuccess === "oauth_connected"
              ? "Facebook account authorized and connected successfully."
              : "Simulated Facebook connection completed successfully."
          });
        } else if (cleanError) {
          setSaveResult({
            success: false,
            message: `Facebook authorization failed: ${cleanError}`
          });
        }
        void loadData(cleanConfigId);
      } else {
        void loadData();
      }
    }
  }, [loadData]);

  const isSecretDirty = useMemo(() => {
    if (!selectedConfigObject) return false;
    const trimmedSecret = formFacebookAppSecret.trim();
    const isMask =
      trimmedSecret === FACEBOOK_SECRET_MASK ||
      trimmedSecret.split("\u2022").join("") === "" ||
      trimmedSecret.split("\u00e2\u20ac\u00a2").join("") === "";

    if (selectedConfigObject.secretConfigured) {
      if (trimmedSecret === "") return true;
      if (!isMask) return true;
      return false;
    } else {
      return trimmedSecret !== "";
    }
  }, [selectedConfigObject, formFacebookAppSecret]);

  const isDirty = useMemo(() => {
    if (selectedConfigId === "new" || !selectedConfigObject) {
      return false;
    }
    const nameChanged = formConfigName.trim() !== selectedConfigObject.configurationName.trim();

    const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");
    const urlChanged = normalizeUrl(formPublicAppUrl) !== normalizeUrl(selectedConfigObject.publicAppUrl);

    const appIdChanged = formFacebookAppId.trim() !== selectedConfigObject.facebookAppId.trim();
    const modeChanged = formLiveMetaMode !== selectedConfigObject.liveMetaMode;
    const enabledChanged = formIsEnabled !== selectedConfigObject.isEnabled;

    return nameChanged || urlChanged || appIdChanged || modeChanged || enabledChanged || isSecretDirty;
  }, [
    selectedConfigId,
    selectedConfigObject,
    formConfigName,
    formPublicAppUrl,
    formFacebookAppId,
    formLiveMetaMode,
    formIsEnabled,
    isSecretDirty
  ]);

  const isNewConfigIncomplete = useMemo(() => {
    if (selectedConfigId !== "new") return false;
    const hasName = !!formConfigName.trim();
    const hasUrl = !!formPublicAppUrl.trim();
    const hasAppId = !!formFacebookAppId.trim();
    const trimmedSecret = formFacebookAppSecret.trim();
    const isMask =
      trimmedSecret === FACEBOOK_SECRET_MASK ||
      trimmedSecret.split("\u2022").join("") === "" ||
      trimmedSecret.split("\u00e2\u20ac\u00a2").join("") === "";
    const hasSecret = trimmedSecret !== "" && !isMask;
    return !hasName || !hasUrl || !hasAppId || !hasSecret;
  }, [selectedConfigId, formConfigName, formPublicAppUrl, formFacebookAppId, formFacebookAppSecret]);



  const sanitizedPublicAppUrl = useMemo(
    () => formPublicAppUrl.trim().replace(/\/+$/, ""),
    [formPublicAppUrl]
  );

  const computedCallbackUrl = useMemo(
    () => (sanitizedPublicAppUrl.length > 0 ? `${sanitizedPublicAppUrl}/api/auth/facebook/callback` : ""),
    [sanitizedPublicAppUrl]
  );

  const hostnameWarning = useMemo(() => {
    if (!formPublicAppUrl || typeof window === "undefined") {
      return null;
    }
    try {
      const configuredUrl = new URL(formPublicAppUrl);
      const currentHost = window.location.host;
      if (configuredUrl.host !== currentHost) {
        return `The configured host (${configuredUrl.host}) does not match the current browser host (${currentHost}). Run validation and authorization from the matching Public App URL.`;
      }
      return null;
    } catch {
      return "The configured Public App URL is not a valid absolute URL.";
    }
  }, [formPublicAppUrl]);

  const isConfigurationIncomplete = useMemo(() => {
    return (
      !formConfigName.trim() ||
      !formPublicAppUrl.trim() ||
      !formFacebookAppId.trim() ||
      !formFacebookAppSecret.trim()
    );
  }, [formConfigName, formPublicAppUrl, formFacebookAppId, formFacebookAppSecret]);

  const handleSelectConfig = (configId: string) => {
    setSaveResult(null);
    setTestResult(null);
    setSelectedConfigId(configId);
    if (configId === "new") {
      applyConfigurationToForm("new");
    } else {
      const config = configurations.find((c) => c.id === configId);
      if (config) {
        applyConfigurationToForm(config);
      }
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/admin/login", { method: "DELETE" });
    } catch (error) {
      console.error("Logout request failed:", error);
    } finally {
      router.replace("/login");
      router.refresh();
    }
  };

  const handleCopyCallback = async () => {
    if (!computedCallbackUrl) return;
    try {
      await navigator.clipboard.writeText(computedCallbackUrl);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    window.setTimeout(() => setCopyStatus("idle"), 2000);
  };

  // Action: Test Configuration
  const handleTestConfiguration = async () => {
    setTestResult(null);
    setSaveResult(null);
    setIsTesting(true);

    try {
      const response = await fetch("/api/admin/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configurationId: selectedConfigId !== "new" ? selectedConfigId : undefined,
          publicAppUrl: formPublicAppUrl,
          facebookAppId: formFacebookAppId,
          facebookAppSecret: formFacebookAppSecret,
          liveMetaMode: formLiveMetaMode
        })
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      const data = (await response.json()) as TestResult;
      setTestResult({
        success: response.ok && data.success === true,
        message: data.message || "Local configuration validation failed.",
        details: data.details
      });
    } catch (error: unknown) {
      setTestResult({
        success: false,
        message: `Network error during configuration testing: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsTesting(false);
    }
  };

  // Action: Save configuration
  const handleSaveConfiguration = async () => {
    setSaveResult(null);
    setTestResult(null);
    setIsSaving(true);

    const payload = {
      configurationName: formConfigName,
      publicAppUrl: formPublicAppUrl,
      facebookAppId: formFacebookAppId,
      facebookAppSecret: formFacebookAppSecret,
      liveMetaMode: formLiveMetaMode,
      isEnabled: formIsEnabled
    };

    try {
      const url = selectedConfigId === "new" ? "/api/admin/configurations" : `/api/admin/configurations/${selectedConfigId}`;
      const method = selectedConfigId === "new" ? "POST" : "PATCH";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      const data = await response.json();

      if (response.ok && data.success) {
        const nextId = data.config.id;
        setSaveResult({
          success: true,
          message: "Meta App configuration saved securely."
        });
        await loadData(nextId);
      } else {
        setSaveResult({
          success: false,
          message: data.error || "Failed to save configurations."
        });
      }
    } catch (error: unknown) {
      setSaveResult({
        success: false,
        message: `Network error while saving: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Action: Set as Default
  const handleSetAsDefault = async () => {
    if (selectedConfigId === "new") return;
    setSaveResult(null);
    setTestResult(null);

    try {
      const response = await fetch(`/api/admin/configurations/${selectedConfigId}/default`, {
        method: "POST"
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      const data = await response.json();
      if (response.ok) {
        setSaveResult({
          success: true,
          message: "Configuration promoted to default successfully."
        });
        await loadData(selectedConfigId);
      } else {
        setSaveResult({
          success: false,
          message: data.error || "Failed to promote default configuration."
        });
      }
    } catch (error: unknown) {
      setSaveResult({
        success: false,
        message: `Error promoting configuration: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  };

  // Action: Sync Facebook Account Pages
  const handleSyncAccount = async (accountId: string) => {
    setIsSyncing((prev) => ({ ...prev, [accountId]: true }));
    setSaveResult(null);

    try {
      const response = await fetch(`/api/facebook/sync?accountId=${accountId}`, {
        method: "POST"
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      const data = await response.json();
      if (response.ok) {
        setSaveResult({
          success: true,
          message: "Facebook account Pages synchronized successfully."
        });
        await loadData(selectedConfigId);
      } else {
        setSaveResult({
          success: false,
          message: data.error || "Failed to synchronize Pages."
        });
      }
    } catch (error: unknown) {
      setSaveResult({
        success: false,
        message: `Error syncing account: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsSyncing((prev) => ({ ...prev, [accountId]: false }));
    }
  };

  // Action: Disconnect Facebook Account
  const handleDisconnectAccount = async (accountId: string, accountName: string) => {
    const confirmText = `Are you sure you want to disconnect Facebook account "${accountName}"? All synced Facebook pages under this connection will be disconnected.`;
    if (!window.confirm(confirmText)) {
      return;
    }

    setIsDisconnecting((prev) => ({ ...prev, [accountId]: true }));
    setSaveResult(null);

    try {
      const response = await fetch(`/api/facebook/disconnect?accountId=${accountId}`, {
        method: "POST"
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      const data = await response.json();
      if (response.ok) {
        setSaveResult({
          success: true,
          message: `Disconnected Facebook account "${accountName}" successfully.`
        });
        await loadData(selectedConfigId);
      } else {
        setSaveResult({
          success: false,
          message: data.error || "Failed to disconnect account."
        });
      }
    } catch (error: unknown) {
      setSaveResult({
        success: false,
        message: `Error disconnecting account: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      setIsDisconnecting((prev) => ({ ...prev, [accountId]: false }));
    }
  };

  const defaultConfig = useMemo(() => {
    return configurations.find((c) => c.isDefault) || null;
  }, [configurations]);

  const activeDisplayConfig = selectedConfigId !== "new" ? selectedConfigObject : defaultConfig;
  const displayLiveMode = activeDisplayConfig ? activeDisplayConfig.liveMetaMode : false;
  const displayConfigName = activeDisplayConfig ? activeDisplayConfig.configurationName : "System Default (Not Configured)";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 font-sans text-zinc-900">
      {/* Top Banner indicating mode of active configuration */}
      <div
        className={`flex w-full flex-col items-center justify-center gap-1 px-4 py-2 text-center text-xs font-bold tracking-wide shadow-sm border-b transition-colors sm:flex-row sm:gap-2 sm:text-sm ${
          displayLiveMode
            ? "bg-emerald-50 text-emerald-800 border-emerald-200"
            : "bg-amber-50 text-amber-800 border-amber-200"
        }`}
      >
        <span className="relative flex h-3 w-3 shrink-0">
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${displayLiveMode ? "bg-emerald-400" : "bg-amber-400"}`} />
          <span className={`relative inline-flex h-3 w-3 rounded-full ${displayLiveMode ? "bg-emerald-600" : "bg-amber-600"}`} />
        </span>

        <span>
          {displayLiveMode
            ? `SAVED LIVE META API MODE ACTIVE`
            : `SAVED MOCK META MODE ACTIVE`}
        </span>

        <span className={`font-normal sm:border-l sm:pl-2 ${displayLiveMode ? "sm:border-emerald-300" : "sm:border-amber-300"}`}>
          {displayLiveMode
            ? `Real Meta API requests are configured for saved app: "${displayConfigName}".`
            : `Facebook login and publishing are simulated for saved app: "${displayConfigName}".`}
        </span>

        {isDirty && (
          <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-800 sm:ml-2">
            Unsaved Form Edits
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col lg:flex-row">
        {/* Navigation Sidebar */}
        <aside className="flex w-full shrink-0 flex-col gap-5 border-b border-zinc-200 bg-white p-4 sm:p-6 lg:w-64 lg:border-b-0 lg:border-r lg:border-zinc-200">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-600/20">
              F
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight text-zinc-900">
                FB Multi-Page
              </h1>
              <p className="font-mono text-[10px] text-zinc-500">v1.0.0-phase7b</p>
            </div>
          </div>

          <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex lg:flex-col">
            <Link
              href="/"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 lg:text-left lg:text-sm"
            >
              Overview
            </Link>
            <Link
              href="/#publisher"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 lg:text-left lg:text-sm"
            >
              Publisher
            </Link>
            <Link
              href="/#pages"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 lg:text-left lg:text-sm"
            >
              Synced Pages
            </Link>
            <Link
              href="/#logs"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 lg:text-left lg:text-sm"
            >
              Audit Logs
            </Link>
            <Link
              href="/settings/meta-configuration"
              className="col-span-2 rounded-lg border border-indigo-700 bg-indigo-600 px-3 py-2.5 text-center text-xs font-semibold text-white shadow-sm sm:col-span-4 lg:col-span-1 lg:text-left lg:text-sm"
            >
              Meta Configuration
            </Link>
            <Link
              href="/settings/storage"
              className="rounded-lg px-3 py-2.5 text-center text-xs font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 lg:text-left lg:text-sm"
            >
              Google Drive Storage
            </Link>
          </nav>

          <div className="border-t border-zinc-200 pt-4 lg:mt-auto lg:pt-6">
            <p className="text-[10px] uppercase tracking-wide text-zinc-400">Signed in as</p>
            <p className="mt-1 truncate text-xs text-zinc-600 font-medium">{adminEmail}</p>
            <button
              type="button"
              onClick={handleLogout}
              className="mt-3 text-left text-xs font-semibold text-rose-500 transition hover:text-rose-600"
            >
              Log Out
            </button>
          </div>
        </aside>

        {/* Main Panel */}
        <main className="min-w-0 flex-1 space-y-7 overflow-y-auto bg-zinc-50 p-4 sm:p-6 lg:p-8">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
                Administration Settings
              </span>
              <h2 className="mt-1 text-2xl font-bold text-zinc-900">
                Meta App Configuration Manager
              </h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">
                Manage multiple Meta API configurations, choose which app ID to connect your Facebook accounts through, and monitor synced pages.
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={() => handleSelectConfig("new")}
                className="w-full shrink-0 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 sm:w-auto"
              >
                + Add Meta App
              </button>
            </div>
          </header>

          {/* System error notification */}
          {errorMsg && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-medium leading-relaxed text-rose-800">
              <strong>Error Loading Settings: </strong> {errorMsg}
            </div>
          )}

          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-3">
            {/* Left side: Meta App configurations list */}
            <section className="space-y-4 xl:col-span-1">
              <h3 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide text-xs">
                My Meta Applications
              </h3>

              {isLoading ? (
                <div className="py-12 text-center font-mono text-xs text-zinc-400 bg-white rounded-xl border border-zinc-200">
                  Loading applications configurations...
                </div>
              ) : configurations.length === 0 ? (
                <div className="py-12 text-center text-xs italic text-zinc-400 bg-white rounded-xl border border-zinc-200">
                  No Meta App configurations defined. Click &quot;+ Add Meta App&quot; to get started.
                </div>
              ) : (
                <div className="space-y-3">
                  {configurations.map((config) => {
                    const isSelected = config.id === selectedConfigId;
                    return (
                      <button
                        type="button"
                        key={config.id}
                        onClick={() => handleSelectConfig(config.id)}
                        className={`w-full text-left block rounded-xl border p-4 transition-all hover:shadow-sm ${
                          isSelected
                            ? "border-indigo-600 bg-indigo-50/40 ring-1 ring-indigo-600"
                            : "border-zinc-200 bg-white hover:border-zinc-300"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="truncate text-sm font-bold text-zinc-900">
                            {config.configurationName}
                          </h4>
                          <div className="flex shrink-0 gap-1">
                            {config.isDefault && (
                              <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[9px] font-bold text-white uppercase">
                                Default
                              </span>
                            )}
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                config.isEnabled
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-zinc-200 text-zinc-600"
                              }`}
                            >
                              {config.isEnabled ? "Enabled" : "Disabled"}
                            </span>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[10px] text-zinc-500">
                          <div>App ID:</div>
                          <div className="truncate text-zinc-700 font-semibold">{config.facebookAppId}</div>
                          <div>Mode:</div>
                          <div className="text-zinc-700 font-semibold">{config.liveMetaMode ? "Live (Prod)" : "Mock (Local)"}</div>
                          <div>Connections:</div>
                          <div className="text-zinc-700">{config.accountCount} Accounts, {config.pageCount} Pages</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Right side: Editor & Selected actions */}
            <section className="space-y-6 xl:col-span-2">
              <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-6 space-y-6">
                <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
                  <h3 className="text-sm font-semibold text-zinc-900">
                    {selectedConfigId === "new" ? "Add New Configuration" : `Editor - ${formConfigName}`}
                  </h3>
                  {selectedConfigId !== "new" && selectedConfigObject?.isDefault && (
                    <span className="text-[10px] text-indigo-600 font-bold uppercase">
                      Active Default App
                    </span>
                  )}
                </div>

                {isConfigurationIncomplete && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-relaxed text-rose-800">
                    <strong>Incomplete details:</strong> Please fill in all fields (Name, App URL, App ID, and App Secret) before authorization.
                  </div>
                )}

                {hostnameWarning && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-800">
                    <strong>Hostname warning:</strong> {hostnameWarning}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label htmlFor="config-name" className="mb-1.5 block font-mono text-[10px] font-bold uppercase text-zinc-400">
                      Configuration Name
                    </label>
                    <input
                      id="config-name"
                      type="text"
                      value={formConfigName}
                      onChange={(e) => setFormConfigName(e.target.value)}
                      placeholder="e.g. Production Application Setup"
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label htmlFor="public-app-url" className="mb-1.5 block font-mono text-[10px] font-bold uppercase text-zinc-400">
                      Public Application URL
                    </label>
                    <input
                      id="public-app-url"
                      type="url"
                      value={formPublicAppUrl}
                      onChange={(e) => setFormPublicAppUrl(e.target.value)}
                      placeholder="https://yourdomain.com"
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    />
                    <p className="mt-1 text-[10px] text-zinc-500">
                      Root URL of this deployment. Must be HTTPS in Live Mode.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="facebook-app-id" className="mb-1.5 block font-mono text-[10px] font-bold uppercase text-zinc-400">
                      Facebook App ID
                    </label>
                    <input
                      id="facebook-app-id"
                      type="text"
                      value={formFacebookAppId}
                      onChange={(e) => setFormFacebookAppId(e.target.value)}
                      placeholder="e.g. 109238472918"
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 font-mono text-sm text-zinc-900 outline-none transition focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="facebook-app-secret" className="mb-1.5 block font-mono text-[10px] font-bold uppercase text-zinc-400">
                      Facebook App Secret
                    </label>
                    <input
                      id="facebook-app-secret"
                      type="password"
                      value={formFacebookAppSecret}
                      onChange={(e) => setFormFacebookAppSecret(e.target.value)}
                      placeholder={selectedConfigId === "new" ? "Paste client app secret" : FACEBOOK_SECRET_MASK}
                      className="w-full rounded-lg border border-zinc-200 bg-white px-3.5 py-2.5 text-sm text-zinc-900 outline-none transition focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
                    />
                    <p className="mt-1 text-[10px] text-zinc-500">
                      Secrets are encrypted and never shown. Leaving the mask unchanged keeps your current saved secret.
                    </p>
                  </div>

                  {/* Mode switcher & Enabled status */}
                  <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 sm:flex-row sm:items-center sm:justify-between md:col-span-2">
                    <div className="space-y-0.5">
                      <span className="block text-xs font-bold text-zinc-900">
                        Live Meta API Mode
                      </span>
                      <span className="block text-[10px] leading-relaxed text-zinc-400 max-w-md">
                        Communicate directly with the real Facebook Graph API. Keep turned off to simulate flows on local mock server.
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={formLiveMetaMode}
                      aria-label="Toggle Live Meta API Mode"
                      onClick={() => setFormLiveMetaMode(!formLiveMetaMode)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                        formLiveMetaMode ? "bg-indigo-600" : "bg-zinc-300"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          formLiveMetaMode ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 sm:flex-row sm:items-center sm:justify-between md:col-span-2">
                    <div className="space-y-0.5">
                      <span className="block text-xs font-bold text-zinc-900">
                        Configuration Enabled
                      </span>
                      <span className="block text-[10px] leading-relaxed text-zinc-400 max-w-md">
                        A disabled configuration cannot accept new Facebook connections, and default app configuration cannot be disabled.
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={formIsEnabled}
                      disabled={selectedConfigObject?.isDefault}
                      aria-label="Toggle Configuration Enabled"
                      onClick={() => setFormIsEnabled(!formIsEnabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed ${
                        formIsEnabled ? "bg-indigo-600" : "bg-zinc-300"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          formIsEnabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Callback instructions */}
                  <div className="space-y-2 md:col-span-2">
                    <label htmlFor="callback-url-output" className="block font-mono text-[10px] font-bold uppercase text-zinc-400">
                      OAuth Callback Redirect URI
                    </label>
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                      <input
                        id="callback-url-output"
                        type="text"
                        readOnly
                        value={computedCallbackUrl || "Specify Public App URL first..."}
                        className="min-w-0 flex-1 select-all rounded-lg border border-zinc-200 bg-zinc-100 px-3.5 py-2.5 font-mono text-xs text-zinc-600 outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleCopyCallback}
                        disabled={!computedCallbackUrl}
                        className="shrink-0 rounded-lg border border-zinc-300 bg-zinc-800 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy Failed" : "Copy URL"}
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-400">
                      Provide this URI under Facebook Login settings in Meta Developer Dashboard.
                    </p>
                  </div>
                </div>

                {/* Local validation details output */}
                {testResult && (
                  <div
                    className={`rounded-xl border p-4 font-mono text-xs ${
                      testResult.success
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : "border-rose-200 bg-rose-50 text-rose-800"
                    }`}
                  >
                    <p className="mb-1 text-sm font-bold">
                      {testResult.success ? "Validation Successful" : "Validation Failed"}
                    </p>
                    <p>{testResult.message}</p>
                    {testResult.details !== undefined && (
                      <pre className="mt-3 overflow-x-auto rounded border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-700">
                        {JSON.stringify(testResult.details, null, 2)}
                      </pre>
                    )}
                  </div>
                )}

                {/* Save response status */}
                {saveResult && (
                  <div
                    className={`rounded-xl border p-4 text-xs font-semibold ${
                      saveResult.success
                        ? "border-indigo-200 bg-indigo-50/50 text-indigo-700"
                        : "border-rose-200 bg-rose-50 text-rose-700"
                    }`}
                  >
                    {saveResult.message}
                  </div>
                )}

                {selectedConfigId === "new" && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 font-semibold leading-relaxed">
                    <strong>Note:</strong> A new Meta App must include its own App Secret to enable local validation.
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={handleTestConfiguration}
                      disabled={isTesting || isSaving || isLoading || isNewConfigIncomplete}
                      className="rounded-lg border border-zinc-200 bg-zinc-100 px-4 py-2.5 text-xs font-bold text-zinc-700 transition hover:bg-zinc-200 disabled:opacity-50"
                    >
                      {isTesting ? "Validating..." : "Validate Configuration"}
                    </button>

                    {selectedConfigId !== "new" && (
                      <button
                        type="button"
                        onClick={handleSetAsDefault}
                        disabled={selectedConfigObject?.isDefault || !selectedConfigObject?.isEnabled || isDirty || isLoading}
                        className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-xs font-bold text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-50"
                      >
                        Set as Default
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    {selectedConfigId === "new" && configurations.length > 0 && (
                      <button
                        type="button"
                        onClick={() => handleSelectConfig(configurations[0].id)}
                        className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-xs font-bold text-zinc-700 transition hover:bg-zinc-50"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleSaveConfiguration}
                      disabled={isSaving || isTesting || isLoading}
                      className="rounded-lg bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {isSaving ? "Saving..." : "Save Configuration"}
                    </button>
                  </div>
                </div>
              </div>

              {/* OAuth Initiation connection block */}
              {selectedConfigId !== "new" && selectedConfigObject && (
                <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-6 space-y-4">
                  <h3 className="text-sm font-semibold text-zinc-900">
                    Connect Profiles under: &quot;{selectedConfigObject.configurationName}&quot;
                  </h3>

                  <div className="space-y-4">
                    <p className="text-xs leading-relaxed text-zinc-500">
                      Authenticate your Facebook account using the saved configuration.
                      Mode: <strong className="text-zinc-800">{selectedConfigObject.liveMetaMode ? "Live Meta Graph API" : "Local Mock Simulator"}</strong>
                    </p>

                    <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 font-mono text-[10px] text-zinc-500">
                      <p className="text-[9px] font-bold uppercase tracking-wide text-zinc-900">
                        Requested Scopes:
                      </p>
                      {["pages_show_list", "pages_read_engagement", "pages_manage_posts"].map((perm) => (
                        <div key={perm} className="flex items-center gap-2 text-emerald-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                          {perm}
                        </div>
                      ))}
                    </div>

                    {isDirty ? (
                      <div className="space-y-3">
                        <div className="text-xs text-rose-500 bg-rose-50 border border-rose-200 rounded-lg p-3 font-semibold text-center">
                          Save changes before connecting this account.
                        </div>
                        <button
                          disabled
                          className="block w-full rounded-lg bg-zinc-200 py-3 text-center text-xs font-bold text-zinc-400 cursor-not-allowed"
                        >
                          Connect Facebook Account
                        </button>
                      </div>
                    ) : !selectedConfigObject.isEnabled ? (
                      <div className="space-y-3">
                        <div className="text-xs text-rose-500 bg-rose-50 border border-rose-200 rounded-lg p-3 font-semibold text-center">
                          This configuration is currently Disabled. Enable it first to start authorization.
                        </div>
                        <button
                          disabled
                          className="block w-full rounded-lg bg-zinc-200 py-3 text-center text-xs font-bold text-zinc-400 cursor-not-allowed"
                        >
                          Connect Facebook Account
                        </button>
                      </div>
                    ) : !selectedConfigObject.secretConfigured ? (
                      <div className="space-y-3">
                        <div className="text-xs text-rose-500 bg-rose-50 border border-rose-200 rounded-lg p-3 font-semibold text-center">
                          Please enter a valid App Secret to connect accounts.
                        </div>
                        <button
                          disabled
                          className="block w-full rounded-lg bg-zinc-200 py-3 text-center text-xs font-bold text-zinc-400 cursor-not-allowed"
                        >
                          Connect Facebook Account
                        </button>
                      </div>
                    ) : (
                      <a
                        href={`/api/auth/facebook/initiate?configurationId=${selectedConfigId}`}
                        className="block w-full rounded-lg bg-indigo-600 py-3 text-center text-xs font-bold text-white shadow hover:bg-indigo-500 transition focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        Connect Facebook Account
                      </a>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* Connected Facebook Accounts and Pages grouped under configurations */}
          <section className="mt-8 space-y-4">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-200 pb-3">
              <h3 className="text-base font-bold text-zinc-900">
                Authorized Meta Configurations Hierarchy
              </h3>
              <button
                type="button"
                onClick={() => void loadData(selectedConfigId === "new" ? undefined : selectedConfigId)}
                className="text-xs font-semibold text-indigo-600 transition hover:text-indigo-700"
              >
                Refresh Hierarchy
              </button>
            </div>

            {isLoading ? (
              <div className="py-12 text-center text-xs text-zinc-400 bg-white border border-zinc-200 rounded-xl">
                Loading connections hierarchy tree...
              </div>
            ) : configurations.length === 0 ? (
              <p className="text-center py-6 text-xs italic text-zinc-400">
                No configurations found.
              </p>
            ) : (
              <div className="space-y-6">
                {configurations.map((config) => {
                  const configAccounts = accounts.filter((acc) => acc.appConfigurationId === config.id);

                  return (
                    <div key={config.id} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-6 space-y-4">
                      {/* Configuration Header */}
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-zinc-100 pb-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-bold text-zinc-900">
                              {config.configurationName}
                            </h4>
                            <span className="text-[10px] font-mono text-zinc-400">
                              (App ID: {config.facebookAppId})
                            </span>
                            {config.isDefault && (
                              <span className="rounded-full bg-indigo-600 px-1.5 py-0.5 text-[8px] font-bold text-white uppercase tracking-wider">
                                Default
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-zinc-400">
                            Mode: {config.liveMetaMode ? "Live Mode" : "Local Mock Simulator"} | Status: {config.isEnabled ? "Enabled" : "Disabled"}
                          </p>
                        </div>
                        <div className="text-[10px] text-zinc-500 bg-zinc-50 border border-zinc-200 rounded px-2.5 py-1">
                          {configAccounts.length} Connected Facebook Account{configAccounts.length !== 1 && "s"}
                        </div>
                      </div>

                      {/* Accounts nested list */}
                      {configAccounts.length === 0 ? (
                        <p className="py-2 text-xs italic text-zinc-400 pl-4 border-l-2 border-zinc-100">
                          No Facebook accounts connected under this configuration.
                        </p>
                      ) : (
                        <div className="space-y-4 pl-4 border-l-2 border-zinc-200">
                          {configAccounts.map((account) => (
                            <div key={account.id} className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 space-y-3">
                              {/* Account Header */}
                              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                                <div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-bold text-zinc-900">
                                      {account.name}
                                    </span>
                                    <span
                                      className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold ${getConnectionStateClasses(
                                        account.connectionState
                                      )}`}
                                    >
                                      {account.connectionState}
                                    </span>
                                  </div>
                                  <div className="mt-1 text-[10px] text-zinc-400 space-x-3">
                                    <span>User ID: <span className="font-mono">{account.facebookUserId}</span></span>
                                    <span>Token Expiry: {formatExpiryDate(account.tokenExpiresAt)}</span>
                                  </div>
                                </div>

                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleSyncAccount(account.id)}
                                    disabled={isSyncing[account.id] || isDisconnecting[account.id]}
                                    className="rounded border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-[10px] font-bold text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-50"
                                  >
                                    {isSyncing[account.id] ? "Syncing..." : "Sync Pages"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDisconnectAccount(account.id, account.name)}
                                    disabled={isSyncing[account.id] || isDisconnecting[account.id]}
                                    className="rounded border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[10px] font-bold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
                                  >
                                    {isDisconnecting[account.id] ? "Disconnecting..." : "Disconnect Account"}
                                  </button>
                                </div>
                              </div>

                              {/* Pages nested list */}
                              <div className="pl-4 pt-2 border-t border-zinc-100 space-y-2">
                                <h5 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                                  Linked Facebook Pages ({account.pages?.length ?? 0})
                                </h5>

                                {!account.pages || account.pages.length === 0 ? (
                                  <p className="text-[10px] italic text-zinc-400">
                                    No pages available under this profile.
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                                    {account.pages.map((page) => (
                                      <div key={page.id} className="flex items-center gap-3 rounded border border-zinc-200 bg-white p-2">
                                        {page.pictureUrl && (
                                          // eslint-disable-next-line @next/next/no-img-element -- Dynamic remote Meta URLs cannot be statically pre-configured in next.config
                                          <img
                                            src={page.pictureUrl}
                                            alt={page.name}
                                            className="h-8 w-8 rounded-full bg-zinc-100 border border-zinc-200 shrink-0 object-cover"
                                          />
                                        )}
                                        <div className="min-w-0 flex-1">
                                          <p className="truncate text-xs font-bold text-zinc-800">
                                            {page.name}
                                          </p>
                                          <p className="truncate text-[9px] text-zinc-500">
                                            {page.category}
                                          </p>
                                        </div>
                                        <span
                                          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase font-mono ${
                                            page.tokenStatus === "Valid"
                                              ? "bg-emerald-50 text-emerald-700"
                                              : "bg-rose-50 text-rose-700"
                                          }`}
                                        >
                                          {page.tokenStatus === "Valid" ? "Synced" : "Expired"}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}