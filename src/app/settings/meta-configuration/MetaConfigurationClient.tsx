"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
  connectionState: 'Connected' | 'Token Expiring' | 'Reconnection Required' | 'Permission Missing';
  pages: FacebookPage[];
}

interface MetaConfigurationClientProps {
  adminEmail: string;
}

export default function MetaConfigurationClient({ adminEmail }: MetaConfigurationClientProps) {
  const router = useRouter();

  // Configuration form states
  const [publicAppUrl, setPublicAppUrl] = useState("");
  const [facebookAppId, setFacebookAppId] = useState("");
  const [facebookAppSecret, setFacebookAppSecret] = useState("");
  const [liveMetaMode, setLiveMetaMode] = useState(false);

  // Connected accounts list
  const [accounts, setAccounts] = useState<FacebookAccountUI[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);

  // Test and Save operation states
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; details?: unknown } | null>(null);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  // Load accounts function wrapped in useCallback
  const loadConnectedAccounts = useCallback(async () => {
    setIsLoadingAccounts(true);
    try {
      const res = await fetch("/api/facebook/pages");
      if (res.ok) {
        const data = await res.json();
        if (data && data.accounts) {
          setAccounts(data.accounts);
        }
      }
    } catch (e) {
      console.error("Failed to load connected accounts:", e);
    } finally {
      setIsLoadingAccounts(false);
    }
  }, []);

  // Load configuration function wrapped in useCallback
  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/config");
      if (res.status === 401) {
        router.refresh();
        return;
      }

      if (res.ok) {
        const data = await res.json();
        setPublicAppUrl(data.publicAppUrl || "");
        setFacebookAppId(data.facebookAppId || "");
        setFacebookAppSecret(data.facebookAppSecret || "");
        setLiveMetaMode(data.liveMetaMode || false);
        loadConnectedAccounts();
      }
    } catch (err) {
      console.error("Config load failed:", err);
    }
  }, [loadConnectedAccounts, router]);

  // Check Authentication on Mount
  useEffect(() => {
    const timer = setTimeout(() => {
      loadConfig();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadConfig]);

  // Compute URL matching warning on render
  let hostnameWarning: string | null = null;
  if (publicAppUrl) {
    try {
      const configUrl = new URL(publicAppUrl);
      if (typeof window !== "undefined") {
        const currentHost = window.location.host;
        const configHost = configUrl.host;
        if (configHost !== currentHost) {
          hostnameWarning = `Warning: Configured Public App URL (${configHost}) does not match current browser location (${currentHost}). OAuth redirects may fail unless accessed via the configured URL.`;
        }
      }
    } catch {
      hostnameWarning = "Warning: Configured Public App URL has an invalid URL format.";
    }
  }

  // Form submission: Log Out
  const handleLogout = async () => {
    try {
      await fetch("/api/admin/login", { method: "DELETE" });
      router.refresh();
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  // Callback URL calculator
  const computedCallbackUrl = publicAppUrl
    ? `${publicAppUrl.trim().replace(/\/+$/, "")}/api/auth/facebook/callback`
    : "";

  const handleCopyCallback = () => {
    if (!computedCallbackUrl) return;
    navigator.clipboard.writeText(computedCallbackUrl);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  // Test configuration
  const handleTestConfig = async () => {
    setTestResult(null);
    setSaveResult(null);
    setIsTesting(true);

    try {
      const res = await fetch("/api/admin/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicAppUrl,
          facebookAppId,
          facebookAppSecret,
          liveMetaMode
        })
      });

      const data = await res.json();
      setTestResult(data);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setTestResult({
        success: false,
        message: `Network error during test execution: ${errMsg}`
      });
    } finally {
      setIsTesting(false);
    }
  };

  // Save configuration
  const handleSaveConfig = async () => {
    setSaveResult(null);
    setTestResult(null);
    setIsSaving(true);

    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicAppUrl,
          facebookAppId,
          facebookAppSecret,
          liveMetaMode
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setSaveResult({ success: true, message: "Settings saved and encrypted successfully!" });
        if (data.config) {
          setPublicAppUrl(data.config.publicAppUrl);
          setFacebookAppId(data.config.facebookAppId);
          setFacebookAppSecret(data.config.facebookAppSecret);
          setLiveMetaMode(data.config.liveMetaMode);
        }
      } else {
        setSaveResult({ success: false, message: data.error || "Failed to save configuration settings." });
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setSaveResult({
        success: false,
        message: `Network error during configuration save: ${errMsg}`
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col font-sans text-zinc-300">
      
      {/* Top Meta mode pulsating banner */}
      <div className={`w-full text-zinc-950 text-center py-2 px-4 font-bold flex items-center justify-center gap-2 text-xs md:text-sm tracking-wide shadow-md transition-colors ${
        liveMetaMode ? "bg-emerald-500" : "bg-amber-500"
      }`}>
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-zinc-900 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-zinc-950"></span>
        </span>
        <span>{liveMetaMode ? "LIVE META API INTEGRATION MODE ACTIVE" : "MOCK META MODE ACTIVE"}</span>
        <span className="font-normal border-l border-zinc-900 pl-2">
          {liveMetaMode 
            ? "Publishing requests will interact with the real Meta Graph APIs using encrypted credentials." 
            : "Local Sandbox Simulator. No real Google Cloud uploads or Meta publishing calls are made."}
        </span>
      </div>

      <div className="flex flex-1 flex-col md:flex-row">
        
        {/* Sidebar */}
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
              href="/#publisher"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
            >
              Bulk Video Publisher
            </Link>
            <Link
              href="/#pages"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
            >
              Synced Pages
            </Link>
            <Link
              href="/#logs"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
            >
              Security Audit Logs
            </Link>
            <div className="h-[1px] bg-zinc-800 my-2"></div>
            <Link
              href="/settings/meta-configuration"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium bg-zinc-850 text-white shadow-inner border border-zinc-700/50"
            >
              Meta Configuration
            </Link>
          </nav>

          <div className="mt-auto pt-6 border-t border-zinc-800">
            <div className="text-xs text-zinc-500 flex flex-col gap-1">
              <span className="truncate">Admin: {adminEmail}</span>
              <button 
                onClick={handleLogout}
                className="mt-2 text-left text-xs font-semibold text-rose-400 hover:text-rose-300 transition"
              >
                Log Out Session
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 bg-zinc-950 p-6 md:p-10 overflow-y-auto space-y-8">
          
          <div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-indigo-400 font-semibold">Settings Panel</span>
            <h2 className="text-2xl font-bold text-white mt-1">Meta Configuration</h2>
            <p className="text-xs text-zinc-500 mt-1 max-w-2xl">
              Configure your secure credentials, URLs, and permissions for OAuth authentication and Graph API publishing. All parameters are encrypted.
            </p>
          </div>

          {/* Alert Warnings */}
          <div className="space-y-3 max-w-3xl">
            {(!publicAppUrl || !facebookAppId || !facebookAppSecret || facebookAppSecret.trim() === '') && (
              <div className="bg-rose-950/40 border border-rose-900/50 rounded-xl p-4 text-xs text-rose-400 font-medium leading-relaxed flex items-start gap-3 shadow-md">
                <svg className="h-5 w-5 text-rose-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <span className="font-bold">Meta Configuration Incomplete:</span> Please enter the Public Application URL, Facebook App ID, and Facebook App Secret to configure the Meta Integration.
                </div>
              </div>
            )}

            {publicAppUrl && publicAppUrl.includes('trycloudflare.com') && (
              <div className="bg-amber-950/40 border border-amber-900/50 rounded-xl p-4 text-xs text-amber-400 font-medium leading-relaxed flex items-start gap-3 shadow-md">
                <svg className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <span className="font-bold">Temporary Quick-Tunnel Warning:</span> Your Public Application URL is configured with a temporary <code className="bg-zinc-950 px-1 py-0.5 rounded text-[10px]">trycloudflare.com</code> domain. For production, please set up a permanent custom domain.
                </div>
              </div>
            )}

            {hostnameWarning && (
              <div className="bg-amber-950/40 border border-amber-900/50 rounded-xl p-4 text-xs text-amber-400 font-medium leading-relaxed flex items-start gap-3 shadow-md">
                <svg className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <span className="font-bold">Hostname Mismatch:</span> {hostnameWarning}
                </div>
              </div>
            )}
          </div>

          {/* Config Setup form card */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-6 shadow-md">
              <h3 className="text-sm font-semibold text-white border-b border-zinc-850 pb-3">App Configuration Settings</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                
                <div className="md:col-span-2">
                  <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase font-medium">Public Application URL</label>
                  <input
                    type="text"
                    required
                    value={publicAppUrl}
                    onChange={(e) => setPublicAppUrl(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-650 transition"
                    placeholder="https://respected-blowing-challenges-theater.trycloudflare.com"
                  />
                  <p className="text-[10px] text-zinc-500 mt-1 font-mono">
                    The external address of your host. Must start with https:// in Live Mode. Used to register callback URLs.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase font-medium">Facebook App ID</label>
                  <input
                    type="text"
                    required
                    value={facebookAppId}
                    onChange={(e) => setFacebookAppId(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-650 transition font-mono"
                    placeholder="1046912927711694"
                  />
                  <p className="text-[10px] text-zinc-500 mt-1">
                    App identifier generated on developers.facebook.com
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-mono text-zinc-400 mb-1.5 uppercase font-medium">Facebook App Secret</label>
                  <input
                    type="password"
                    required
                    value={facebookAppSecret}
                    onChange={(e) => setFacebookAppSecret(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-650 transition"
                    placeholder="••••••••••••"
                  />
                  <p className="text-[10px] text-zinc-500 mt-1">
                    Leave unchanged to preserve current encrypted credentials.
                  </p>
                </div>

                <div className="md:col-span-2 flex items-center justify-between bg-zinc-950 p-4 border border-zinc-850 rounded-lg">
                  <div className="space-y-0.5">
                    <span className="block text-xs font-bold text-white">Live Meta Mode Integration</span>
                    <span className="block text-[10px] text-zinc-500 max-w-md">
                      When enabled, real Facebook API calls are executed. When disabled, simulated logins and responses occur.
                    </span>
                  </div>
                  <button
                    onClick={() => setLiveMetaMode(!liveMetaMode)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                      liveMetaMode ? "bg-indigo-650" : "bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        liveMetaMode ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>

                <div className="md:col-span-2 space-y-2">
                  <label className="block text-xs font-mono text-zinc-400 uppercase font-medium">Generated OAuth Callback URL</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={computedCallbackUrl || "Awaiting Public App URL..."}
                      className="flex-1 bg-zinc-950 border border-zinc-800 text-zinc-400 font-mono text-xs rounded-lg px-3.5 py-2.5 select-all focus:outline-none"
                    />
                    <button
                      onClick={handleCopyCallback}
                      disabled={!computedCallbackUrl}
                      className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-semibold text-xs px-4 rounded-lg transition flex items-center gap-1.5 border border-zinc-750"
                    >
                      {isCopied ? "Copied!" : "Copy URL"}
                    </button>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    Register this callback URL exactly inside developers.facebook.com → Facebook Login → Settings → Valid OAuth Redirect URIs.
                  </p>
                </div>

              </div>

              {/* Status responses */}
              {testResult && (
                <div className={`p-4 border rounded-xl font-mono text-xs ${
                  testResult.success 
                    ? "bg-emerald-950/40 border-emerald-900/60 text-emerald-400" 
                    : "bg-rose-950/40 border-rose-900/60 text-rose-400"
                }`}>
                  <div className="font-bold flex items-center gap-1.5 mb-1 text-sm">
                    {testResult.success ? (
                      <>
                        <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Test Completed Successfully
                      </>
                    ) : (
                      <>
                        <svg className="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Test Failed
                      </>
                    )}
                  </div>
                  <p>{testResult.message}</p>
                  {!!testResult.details && (
                    <pre className="mt-3 bg-zinc-950 p-3 rounded border border-zinc-850 overflow-x-auto text-[11px] leading-relaxed text-zinc-300">
                      {JSON.stringify(testResult.details, null, 2)}
                    </pre>
                  )}
                </div>
              )}

              {saveResult && (
                <div className={`p-4 border rounded-xl text-xs font-semibold ${
                  saveResult.success 
                    ? "bg-indigo-950/40 border-indigo-900/60 text-indigo-400" 
                    : "bg-rose-950/40 border-rose-900/60 text-rose-400"
                }`}>
                  <p>{saveResult.message}</p>
                </div>
              )}

              <div className="flex justify-between items-center pt-4 border-t border-zinc-850">
                <button
                  onClick={handleTestConfig}
                  disabled={isTesting || isSaving}
                  className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-bold text-xs px-4 py-2.5 rounded-lg border border-zinc-750 transition"
                >
                  {isTesting ? "Testing Connection..." : "Test Meta Configuration"}
                </button>

                <button
                  onClick={handleSaveConfig}
                  disabled={isSaving || isTesting}
                  className="bg-indigo-650 hover:bg-indigo-600 disabled:bg-indigo-800 text-white font-bold text-xs px-5 py-2.5 rounded-lg transition shadow shadow-indigo-650/20"
                >
                  {isSaving ? "Saving Config..." : "Save Securely"}
                </button>
              </div>

            </div>

            {/* Side Facebook authentication panel */}
            <div className="space-y-6">
              
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-md space-y-4">
                <h3 className="text-sm font-semibold text-white border-b border-zinc-850 pb-3">Authorize Facebook Credentials</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Start the Facebook OAuth login flow to connect a Meta profile. Tokens are retrieved via code-exchange, encrypted on the server, and saved in PostgreSQL.
                </p>

                <div className="bg-zinc-950 border border-zinc-850 p-4 rounded-lg space-y-3 font-mono text-[10px] text-zinc-500">
                  <div className="font-bold text-white uppercase text-[9px] tracking-wide mb-1">Active OAuth Scopes</div>
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    pages_show_list
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    pages_read_engagement
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    pages_manage_posts
                  </div>
                  <div className="text-[9px] mt-2 border-t border-zinc-900 pt-2 leading-relaxed">
                    No publish_video or deprecated permissions are requested.
                  </div>
                </div>

                <a
                  href="/api/auth/facebook/initiate"
                  className="block text-center w-full bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs py-3 rounded-lg border border-zinc-750 transition shadow"
                >
                  {accounts.length > 0 ? "Add Another Facebook Account" : "Connect Facebook Account"}
                </a>
              </div>

              {/* Connected accounts detail list */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-md space-y-4">
                <h3 className="text-sm font-semibold text-white border-b border-zinc-850 pb-3">Connected Meta Accounts</h3>

                {isLoadingAccounts ? (
                  <div className="py-6 text-center text-xs font-mono text-zinc-500">
                    Loading accounts details...
                  </div>
                ) : accounts.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-4 italic text-center">
                    No Facebook accounts linked to this application config.
                  </p>
                ) : (
                  <div className="space-y-4 max-h-[300px] overflow-y-auto pr-1">
                    {accounts.map((acc) => (
                      <div key={acc.id} className="bg-zinc-950 border border-zinc-850 rounded-lg p-3.5 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-white truncate max-w-[120px]">{acc.name}</span>
                          <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full ${
                            acc.connectionState === "Connected" 
                              ? "bg-emerald-950 text-emerald-400 border border-emerald-900/40"
                              : acc.connectionState === "Token Expiring"
                              ? "bg-amber-950 text-amber-400 border border-amber-900/40"
                              : "bg-rose-950 text-rose-400 border border-rose-900/40"
                          }`}>
                            {acc.connectionState}
                          </span>
                        </div>
                        <div className="text-[10px] font-mono text-zinc-500 space-y-0.5">
                          <div>ID: {acc.facebookUserId}</div>
                          <div className="truncate">Expires: {new Date(acc.tokenExpiresAt).toLocaleDateString()}</div>
                          <div>Pages Synced: {acc.pages?.length || 0}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>

          </div>

        </main>
      </div>

    </div>
  );
}
