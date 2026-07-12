"use client";

import React, { useState } from "react";

// Types
interface FacebookPage {
  id: string;
  name: string;
  category: string;
  pictureUrl: string;
  tokenStatus: "Valid" | "Expired";
  connectedAt: string;
}

interface VideoJob {
  id: string;
  fileName: string;
  fileSize: string;
  uploadProgress: number; // 0 to 100
  pageId: string;
  englishTitle: string;
  englishCaption: string;
  hashtags: string;
  scheduledTimeKolkata: string; // "YYYY-MM-DDTHH:MM"
  scheduledTimeUTC: string;
  status: "DRAFT" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "FAILED";
  metaPostId?: string;
  retryCount: number;
  errorLog?: string;
  customThumbnailName?: string;
}

interface SecurityLog {
  timestampUTC: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
}

// Initial Mock Data
const INITIAL_PAGES: FacebookPage[] = [
  {
    id: "1029384756",
    name: "Tech Reviews Daily",
    category: "Media/News Company",
    pictureUrl: "https://api.dicebear.com/7.x/identicon/svg?seed=tech",
    tokenStatus: "Valid",
    connectedAt: "2026-07-12T10:00:00Z",
  },
  {
    id: "5647382910",
    name: "Gaming Zone Live",
    category: "Gaming Creator",
    pictureUrl: "https://api.dicebear.com/7.x/identicon/svg?seed=gaming",
    tokenStatus: "Valid",
    connectedAt: "2026-07-12T10:15:00Z",
  },
  {
    id: "9876543210",
    name: "Travel & Culinary Guides",
    category: "Travel & Leisure",
    pictureUrl: "https://api.dicebear.com/7.x/identicon/svg?seed=travel",
    tokenStatus: "Valid",
    connectedAt: "2026-07-12T10:30:00Z",
  },
];

const INITIAL_JOBS: VideoJob[] = [
  {
    id: "job-1",
    fileName: "ai_trends_2026.mp4",
    fileSize: "45.2 MB",
    uploadProgress: 100,
    pageId: "1029384756",
    englishTitle: "Top 5 AI Tools of 2026 You Must Use",
    englishCaption: "AI is evolving rapidly. Here are the tools to boost your productivity this year.",
    hashtags: "#AITools #Productivity #TechTrends",
    scheduledTimeKolkata: "2026-07-12T19:30", // local representation
    scheduledTimeUTC: "2026-07-12T14:00:00.000Z",
    status: "SCHEDULED",
    retryCount: 0,
  },
  {
    id: "job-2",
    fileName: "gaming_highlights_ep12.mp4",
    fileSize: "128.5 MB",
    uploadProgress: 100,
    pageId: "5647382910",
    englishTitle: "Clutch 1v4 Outplay in Finals!",
    englishCaption: "Unbelievable victory in the final round of the tourney. Drop a like!",
    hashtags: "#ClutchGaming #FinalsOutplay #FPSGames",
    scheduledTimeKolkata: "2026-07-12T21:30",
    scheduledTimeUTC: "2026-07-12T16:00:00.000Z",
    status: "SCHEDULED",
    retryCount: 0,
  },
  {
    id: "job-3",
    fileName: "mumbai_street_food_vlog.mp4",
    fileSize: "284.1 MB",
    uploadProgress: 100,
    pageId: "9876543210",
    englishTitle: "Spiciest Street Food in Mumbai - Vlog #45",
    englishCaption: "Exploring the legendary street foods of Mumbai. Tasting the ultimate Vada Pav!",
    hashtags: "#StreetFood #MumbaiVlog #FoodTravel",
    scheduledTimeKolkata: "2026-07-12T23:30",
    scheduledTimeUTC: "2026-07-12T18:00:00.000Z",
    status: "DRAFT",
    retryCount: 0,
  },
];

export default function Home() {
  // Navigation State
  const [activeTab, setActiveTab] = useState<"dashboard" | "publisher" | "pages" | "logs">("dashboard");

  // Core Functional States
  const [pages, setPages] = useState<FacebookPage[]>(INITIAL_PAGES);
  const [jobs, setJobs] = useState<VideoJob[]>(INITIAL_JOBS);
  const [securityLogs, setSecurityLogs] = useState<SecurityLog[]>([
    { timestampUTC: "2026-07-12T11:30:00Z", level: "INFO", message: "System initialized in Mock Meta Mode." },
    { timestampUTC: "2026-07-12T11:31:05Z", level: "INFO", message: "Loaded 3 Facebook Pages from database schema (Mock)." },
    { timestampUTC: "2026-07-12T11:32:10Z", level: "INFO", message: "Loaded 3 existing scheduled/draft video jobs." },
  ]);

  // UI Interactive States
  const [isSyncingPages, setIsSyncingPages] = useState(false);
  const [simulateTokenExpiry, setSimulateTokenExpiry] = useState(false);
  const [simulatingPublish, setSimulatingPublish] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);
  
  // Form Uploading States
  const [uploadingFiles, setUploadingFiles] = useState<{ name: string; progress: number; size: string }[]>([]);

  // Bulk interval scheduler inputs
  const [intervalStartKolkata, setIntervalStartKolkata] = useState("2026-07-13T09:00");
  const [intervalHours, setIntervalHours] = useState(2);

  // Timezone helper
  const kolkataOffsetStr = "UTC+05:30 (Asia/Kolkata)";

  // Format Helper for Kolkata local time input into UTC
  const convertKolkataToUTC = (kolkataTimeStr: string): string => {
    if (!kolkataTimeStr) return "";
    const date = new Date(kolkataTimeStr + "+05:30");
    return date.toISOString();
  };

  // Convert Date object/string to clean display string
  const formatDateTime = (isoString: string) => {
    return isoString.replace("T", " ").substring(0, 16);
  };

  // Generate logs helper
  const addSecurityLog = (level: "INFO" | "WARN" | "ERROR", message: string) => {
    const newLog: SecurityLog = {
      timestampUTC: new Date().toISOString(),
      level,
      message,
    };
    setSecurityLogs((prev) => [newLog, ...prev]);
  };

  // Validate English check
  const isEnglishOnly = (text: string): boolean => {
    // Basic regex: Allow standard letters, numbers, spaces, punctuation, emojis and standard symbols
    const englishRegex = /^[a-zA-Z0-9\s.,!@#$&*()_\-+=\[\]{}|\\\/;:'"?%]*$/;
    // Check if characters contain non-English ranges (like Cyrillic, Chinese, Devanagari, etc)
    return englishRegex.test(text);
  };

  // Sync pages simulator
  const handleSyncPages = () => {
    setIsSyncingPages(true);
    addSecurityLog("INFO", "Initiated managed Facebook Pages synchronization request.");
    
    setTimeout(() => {
      setIsSyncingPages(false);
      // Reset pages to active configuration
      setPages(
        INITIAL_PAGES.map((page) => ({
          ...page,
          tokenStatus: simulateTokenExpiry ? "Expired" : "Valid",
        }))
      );
      addSecurityLog("INFO", `Fetched ${INITIAL_PAGES.length} pages from Meta Graph API. Tokens encrypted and saved.`);
    }, 1500);
  };

  // Toggle token status simulator
  const handleToggleTokenExpiry = () => {
    const nextState = !simulateTokenExpiry;
    setSimulateTokenExpiry(nextState);
    setPages((prev) =>
      prev.map((page) => ({
        ...page,
        tokenStatus: nextState ? "Expired" : "Valid",
      }))
    );
    addSecurityLog(
      nextState ? "WARN" : "INFO",
      nextState
        ? "Simulated Facebook access token expiration: Triggered Code 190."
        : "Simulated Facebook access token validation restored."
    );
  };

  // Reconnect Simulator
  const handleReconnectAccount = (pageId: string) => {
    setPages((prev) =>
      prev.map((page) => (page.id === pageId ? { ...page, tokenStatus: "Valid" } : page))
    );
    addSecurityLog("INFO", `Reconnected Page Access Token for Page ID: ${pageId} via Mock OAuth.`);
  };

  // Mock Upload Selector
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const filesArray = Array.from(e.target.files);
    
    filesArray.forEach((file) => {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1) + " MB";
      const fileObj = { name: file.name, progress: 0, size: fileSizeMB };
      
      setUploadingFiles((prev) => [...prev, fileObj]);

      // Simulate GCS Upload Progress
      let progress = 0;
      const interval = setInterval(() => {
        progress += 20;
        setUploadingFiles((prev) =>
          prev.map((f) => (f.name === file.name ? { ...f, progress } : f))
        );

        if (progress >= 100) {
          clearInterval(interval);
          // Add to Video Jobs list as DRAFT
          const newJob: VideoJob = {
            id: "job-" + Math.random().toString(36).substr(2, 9),
            fileName: file.name,
            fileSize: fileSizeMB,
            uploadProgress: 100,
            pageId: pages[0]?.id || "",
            englishTitle: file.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "), // default title
            englishCaption: "Simulated Caption for " + file.name,
            hashtags: "#MockVideo #Upload",
            scheduledTimeKolkata: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().substring(0, 16), // tomorrow
            scheduledTimeUTC: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            status: "DRAFT",
            retryCount: 0,
          };
          setJobs((prev) => [...prev, newJob]);
          // Clean up from uploading queue
          setUploadingFiles((prev) => prev.filter((f) => f.name !== file.name));
          addSecurityLog("INFO", `File ${file.name} successfully uploaded to direct GCS mock bucket: gcs-bucket-sandbox/videos/${newJob.id}.mp4`);
        }
      }, 400);
    });
  };

  // Edit fields inside Job
  const handleUpdateJobField = (jobId: string, field: keyof VideoJob, value: string | number | undefined) => {
    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job;
        
        const updated = { ...job, [field]: value };
        
        // Sync time conversions
        if (field === "scheduledTimeKolkata" && typeof value === "string") {
          updated.scheduledTimeUTC = convertKolkataToUTC(value);
        }
        
        return updated;
      })
    );
  };

  // Bulk Apply Interval Scheduling
  const handleApplyIntervals = () => {
    const drafts = jobs.filter((job) => job.status === "DRAFT");
    if (drafts.length === 0) {
      alert("No DRAFT video jobs available to bulk-schedule. Try uploading some files first!");
      return;
    }

    const currentKolkataTime = new Date(intervalStartKolkata);
    
    setJobs((prev) => {
      let draftIndex = 0;
      return prev.map((job) => {
        if (job.status !== "DRAFT") return job;

        // Space out by intervalHours
        const scheduledTime = new Date(currentKolkataTime.getTime());
        scheduledTime.setHours(scheduledTime.getHours() + draftIndex * intervalHours);
        
        const scheduledKolkataStr = scheduledTime.toISOString().substring(0, 16);
        const scheduledUTCStr = scheduledTime.toISOString();

        draftIndex++;

        return {
          ...job,
          scheduledTimeKolkata: scheduledKolkataStr,
          scheduledTimeUTC: scheduledUTCStr,
          status: "SCHEDULED",
        };
      });
    });

    addSecurityLog(
      "INFO",
      `Bulk scheduled ${drafts.length} draft videos spaced every ${intervalHours} hour(s) starting from ${formatDateTime(
        intervalStartKolkata
      )}.`
    );
  };

  // Delete Job
  const handleDeleteJob = (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    addSecurityLog("INFO", `Deleted video job: ${id}. Cancelled corresponding Mock Cloud Task.`);
  };

  // Simulating Worker Publishing Execution
  const handleSimulateQueueWorker = () => {
    const pendingJobs = jobs.filter((j) => j.status === "SCHEDULED");
    if (pendingJobs.length === 0) {
      setSimulationLog(["No SCHEDULED jobs found to execute."]);
      return;
    }

    setSimulatingPublish(true);
    setSimulationLog(["Initializing Queue Worker...", "Establishing connection to database..."]);

    let currentSimStep = 0;
    const targetJob = pendingJobs[0];

    const runSteps = [
      () => {
        // Change status to publishing
        setJobs((prev) => prev.map((j) => (j.id === targetJob.id ? { ...j, status: "PUBLISHING" } : j)));
        setSimulationLog((prev) => [...prev, `[Worker] Triggered by Cloud Tasks webhook for Job: ${targetJob.id}`]);
      },
      () => {
        // Retrieve and decrypt token
        const targetPage = pages.find((p) => p.id === targetJob.pageId);
        setSimulationLog((prev) => [
          ...prev,
          `[Worker] Fetching target page token for Page ID: ${targetJob.pageId} (${targetPage?.name || "Unknown"})`,
        ]);
      },
      () => {
        const targetPage = pages.find((p) => p.id === targetJob.pageId);
        // REDACTED TOKEN CHECK
        setSimulationLog((prev) => [
          ...prev,
          `[Worker] Decrypting page access token: EAAC8v9... [REDACTED]`,
        ]);
        addSecurityLog("INFO", `Decrypting credentials for Page: ${targetPage?.name}. Token: EAAC8v9... [REDACTED]`);
      },
      () => {
        setSimulationLog((prev) => [...prev, `[Worker] Downloading file: gcs-bucket-sandbox/videos/${targetJob.fileName}`]);
      },
      () => {
        setSimulationLog((prev) => [...prev, `[Worker] Initiating chunked upload to Meta API (Reels & Videos)...`]);
      },
      () => {
        setSimulationLog((prev) => [...prev, `[Worker] Processing English metadata validation checks...`]);
      },
      () => {
        const targetPage = pages.find((p) => p.id === targetJob.pageId);
        
        // Token Expiration simulator triggers Failure
        if (targetPage?.tokenStatus === "Expired") {
          setSimulationLog((prev) => [
            ...prev,
            `[Worker] [API ERROR] Facebook Graph API returned Code 190: Invalid or expired access token.`,
            `[Worker] Transitioning job ${targetJob.id} to FAILED status.`,
          ]);
          setJobs((prev) =>
            prev.map((j) =>
              j.id === targetJob.id
                ? {
                    ...j,
                    status: "FAILED",
                    errorLog: "Meta API Code 190: Expired User/Page access token. Re-authorization required.",
                  }
                : j
            )
          );
          addSecurityLog("ERROR", `Failed executing Job ${targetJob.id}: Facebook access token expired.`);
          setSimulatingPublish(false);
          return;
        }

        // Validate English
        if (!isEnglishOnly(targetJob.englishTitle) || !isEnglishOnly(targetJob.englishCaption)) {
          setSimulationLog((prev) => [
            ...prev,
            `[Worker] [COMPLIANCE ERROR] Metadata contains non-English characters. Publication aborted.`,
            `[Worker] Transitioning job ${targetJob.id} to FAILED status.`,
          ]);
          setJobs((prev) =>
            prev.map((j) =>
              j.id === targetJob.id
                ? { ...j, status: "FAILED", errorLog: "Compliance Error: Non-English characters in title or caption." }
                : j
            )
          );
          addSecurityLog("ERROR", `Failed executing Job ${targetJob.id}: Compliance Check failed (Non-English characters).`);
          setSimulatingPublish(false);
          return;
        }

        // Title Length
        if (targetJob.englishTitle.length > 255) {
          setSimulationLog((prev) => [
            ...prev,
            `[Worker] [API ERROR] Video title exceeds maximum character limit of 255.`,
            `[Worker] Transitioning job ${targetJob.id} to FAILED status.`,
          ]);
          setJobs((prev) =>
            prev.map((j) =>
              j.id === targetJob.id
                ? { ...j, status: "FAILED", errorLog: "Meta API Limit: Title exceeds 255 characters." }
                : j
            )
          );
          addSecurityLog("ERROR", `Failed executing Job ${targetJob.id}: Title exceeded length bounds.`);
          setSimulatingPublish(false);
          return;
        }

        // Random retry simulation
        if (targetJob.retryCount === 0 && Math.random() > 0.65) {
          setSimulationLog((prev) => [
            ...prev,
            `[Worker] [API WARNING] Meta server returned HTTP 429: Rate Limit Exceeded. Retrying job with exponential backoff...`,
          ]);
          setJobs((prev) =>
            prev.map((j) => (j.id === targetJob.id ? { ...j, status: "SCHEDULED", retryCount: 1 } : j))
          );
          addSecurityLog("WARN", `Transient HTTP 429 received for Job ${targetJob.id}. Retry scheduled.`);
          setSimulatingPublish(false);
          return;
        }

        // Success Publishing
        const mockMetaPostId = Math.floor(1000000000000 + Math.random() * 9000000000000).toString();
        setSimulationLog((prev) => [
          ...prev,
          `[Worker] Video chunks uploaded successfully.`,
          `[Worker] Custom thumbnail registered.`,
          `[Worker] Meta API Post created: /pages/${targetJob.pageId}/videos. Post ID: ${mockMetaPostId}`,
          `[Worker] Success! Job status updated.`,
        ]);
        setJobs((prev) =>
          prev.map((j) =>
            j.id === targetJob.id
              ? { ...j, status: "PUBLISHED", metaPostId: mockMetaPostId, errorLog: undefined }
              : j
          )
        );
        addSecurityLog("INFO", `Published scheduled video ${targetJob.fileName} to Page. Meta ID: ${mockMetaPostId}.`);
        setSimulatingPublish(false);
      },
    ];

    const runInterval = setInterval(() => {
      if (currentSimStep < runSteps.length) {
        runSteps[currentSimStep]();
        currentSimStep++;
      } else {
        clearInterval(runInterval);
      }
    }, 600);
  };

  // Reset demo defaults
  const handleResetDemo = () => {
    setJobs(INITIAL_JOBS);
    setPages(INITIAL_PAGES);
    setSimulateTokenExpiry(false);
    setSimulationLog([]);
    addSecurityLog("INFO", "Reset simulator demo state.");
  };

  // Stat Counters
  const countPages = pages.length;
  const countScheduled = jobs.filter((j) => j.status === "SCHEDULED").length;
  const countPublishing = jobs.filter((j) => j.status === "PUBLISHING").length;
  const countPublished = jobs.filter((j) => j.status === "PUBLISHED").length;
  const countFailed = jobs.filter((j) => j.status === "FAILED").length;

  // Warning for expired tokens
  const hasExpiredTokens = pages.some((p) => p.tokenStatus === "Expired");

  return (
    <div className="flex flex-col flex-1 bg-zinc-950 text-zinc-100 font-sans min-h-screen">
      
      {/* 1. MOCK META MODE TOP PULSATING BANNER */}
      <div className="w-full bg-amber-500 text-zinc-950 text-center py-2 px-4 font-bold flex items-center justify-center gap-2 text-xs md:text-sm tracking-wide shadow-md">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-zinc-900 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-zinc-950"></span>
        </span>
        <span>MOCK META MODE ACTIVE</span>
        <span className="font-normal border-l border-zinc-900 pl-2">
          Local Sandbox Simulator. No real endpoints are charged or queried.
        </span>
        <button
          onClick={handleResetDemo}
          className="ml-auto bg-zinc-950 text-amber-500 hover:bg-zinc-900 text-xs px-2.5 py-1 rounded font-semibold transition"
        >
          Reset Demo State
        </button>
      </div>

      {/* Reconnection Alert Banner if Token Expired */}
      {hasExpiredTokens && (
        <div className="w-full bg-rose-600 text-white text-center py-2.5 px-4 font-semibold text-sm flex items-center justify-center gap-3 animate-pulse">
          <svg
            className="h-5 w-5 flex-shrink-0"
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
          <span>Facebook API Code 190 Alert: One or more Page tokens have expired. Reconnection OAuth login required!</span>
          <button
            onClick={() => handleReconnectAccount(pages.find(p => p.tokenStatus === "Expired")?.id || "")}
            className="bg-white text-rose-600 hover:bg-zinc-100 text-xs px-3 py-1 rounded-full font-bold transition shadow"
          >
            Quick Reconnect
          </button>
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="flex flex-1 flex-col md:flex-row">
        
        {/* SIDEBAR NAVIGATION */}
        <aside className="w-full md:w-64 bg-zinc-900 border-r border-zinc-800 p-6 flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-600/30">
              F
            </div>
            <div>
              <h1 className="font-semibold text-sm leading-tight text-white">FB Multi-Page</h1>
              <p className="text-[10px] text-zinc-500 font-mono">v1.0.0-phase1</p>
            </div>
          </div>

          <nav className="flex flex-col gap-1.5">
            <button
              onClick={() => setActiveTab("dashboard")}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium ${
                activeTab === "dashboard"
                  ? "bg-zinc-800 text-white shadow-inner border border-zinc-700/50"
                  : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
              }`}
            >
              Overview Dashboard
            </button>
            <button
              onClick={() => setActiveTab("publisher")}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium ${
                activeTab === "publisher"
                  ? "bg-zinc-800 text-white shadow-inner border border-zinc-700/50"
                  : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
              }`}
            >
              Bulk Video Publisher
            </button>
            <button
              onClick={() => setActiveTab("pages")}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium ${
                activeTab === "pages"
                  ? "bg-zinc-800 text-white shadow-inner border border-zinc-700/50"
                  : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
              }`}
            >
              Synced Pages ({countPages})
            </button>
            <button
              onClick={() => setActiveTab("logs")}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium ${
                activeTab === "logs"
                  ? "bg-zinc-800 text-white shadow-inner border border-zinc-700/50"
                  : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
              }`}
            >
              Security Audit Logs
            </button>
          </nav>

          {/* Quick Simulation Options */}
          <div className="mt-auto pt-6 border-t border-zinc-800">
            <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-500 mb-3">Simulation Console</h3>
            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3.5 flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Trigger Expired Token</span>
                <input
                  type="checkbox"
                  checked={simulateTokenExpiry}
                  onChange={handleToggleTokenExpiry}
                  className="rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-indigo-600 h-4 w-4"
                />
              </div>
              <button
                onClick={handleSimulateQueueWorker}
                disabled={simulatingPublish}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-800 disabled:text-zinc-500 font-semibold text-xs text-white py-2 px-3 rounded transition shadow-md shadow-indigo-600/10 flex items-center justify-center gap-1.5"
              >
                {simulatingPublish ? (
                  <>
                    <span className="animate-spin h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full"></span>
                    Running...
                  </>
                ) : (
                  "Simulate Queue Worker"
                )}
              </button>
            </div>
          </div>
        </aside>

        {/* CONTENT INTERFACE */}
        <main className="flex-1 flex flex-col bg-zinc-950">
          
          {/* Top Bar Header */}
          <header className="h-16 border-b border-zinc-900 px-8 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-white tracking-tight capitalize">
                {activeTab === "dashboard" ? "Dashboard Overview" : activeTab}
              </h2>
              <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded font-mono border border-zinc-700/30">
                {kolkataOffsetStr}
              </span>
            </div>
            
            <div className="flex items-center gap-4 text-xs font-mono text-zinc-400">
              <span>Timezone: Asia/Kolkata</span>
              <span className="text-zinc-600">|</span>
              <span>Local System Time: 2026-07-12 17:13:03</span>
            </div>
          </header>

          {/* Core Panel Content */}
          <div className="p-8 overflow-y-auto max-w-7xl w-full mx-auto flex-1">
            
            {/* STATS METRIC GRID */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 shadow-sm hover:border-zinc-700/50 transition">
                <span className="text-xs font-mono text-zinc-500">Connected Pages</span>
                <h4 className="text-3xl font-extrabold text-white mt-1.5">{countPages}</h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 shadow-sm hover:border-zinc-700/50 transition">
                <span className="text-xs font-mono text-zinc-500">Scheduled Jobs</span>
                <h4 className="text-3xl font-extrabold text-indigo-400 mt-1.5">{countScheduled}</h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 shadow-sm hover:border-zinc-700/50 transition">
                <span className="text-xs font-mono text-zinc-500">Publishing Jobs</span>
                <h4 className="text-3xl font-extrabold text-amber-400 mt-1.5 flex items-center gap-2">
                  {countPublishing}
                  {countPublishing > 0 && <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping"></span>}
                </h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 shadow-sm hover:border-zinc-700/50 transition">
                <span className="text-xs font-mono text-zinc-500">Published Jobs</span>
                <h4 className="text-3xl font-extrabold text-emerald-400 mt-1.5">{countPublished}</h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 shadow-sm hover:border-zinc-700/50 transition">
                <span className="text-xs font-mono text-zinc-500">Failed Jobs</span>
                <h4 className="text-3xl font-extrabold text-rose-500 mt-1.5">{countFailed}</h4>
              </div>
            </div>

            {/* TAB CONTAINER CONTENT */}
            {activeTab === "dashboard" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                
                {/* Timeline Queue Monitor */}
                <div className="lg:col-span-2 flex flex-col gap-6">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-base font-bold text-white">Publishing Timeline Queue</h3>
                      <span className="text-xs text-zinc-500 font-mono">Times displayed in Asia/Kolkata</span>
                    </div>

                    {jobs.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-800 rounded-lg">
                        No videos loaded. Open the &quot;Bulk Video Publisher&quot; to schedule files.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm border-collapse">
                          <thead>
                            <tr className="border-b border-zinc-800 text-zinc-500 font-mono text-xs uppercase">
                              <th className="pb-3 pr-4">File Name</th>
                              <th className="pb-3 px-4">Target Page</th>
                              <th className="pb-3 px-4">Scheduled Date/Time (Kolkata)</th>
                              <th className="pb-3 px-4">Status</th>
                              <th className="pb-3 pl-4 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/50">
                            {jobs.map((job) => {
                              const targetPage = pages.find((p) => p.id === job.pageId);
                              return (
                                <tr key={job.id} className="hover:bg-zinc-800/20 group transition">
                                  <td className="py-4 pr-4">
                                    <div className="font-medium text-white max-w-[180px] truncate">{job.fileName}</div>
                                    <div className="text-xs text-zinc-500 mt-0.5">{job.fileSize}</div>
                                  </td>
                                  <td className="py-4 px-4 text-zinc-300 font-medium">
                                    {targetPage?.name || "Unassigned"}
                                  </td>
                                  <td className="py-4 px-4 font-mono text-xs">
                                    <div className="text-zinc-300">{formatDateTime(job.scheduledTimeKolkata)}</div>
                                    <div className="text-[10px] text-zinc-600 mt-0.5">UTC: {formatDateTime(job.scheduledTimeUTC)}Z</div>
                                  </td>
                                  <td className="py-4 px-4">
                                    {job.status === "DRAFT" && (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700/30">
                                        Draft
                                      </span>
                                    )}
                                    {job.status === "SCHEDULED" && (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-950 text-indigo-400 border border-indigo-900/40">
                                        Scheduled
                                      </span>
                                    )}
                                    {job.status === "PUBLISHING" && (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-950 text-amber-400 border border-amber-900/40 animate-pulse">
                                        Publishing
                                      </span>
                                    )}
                                    {job.status === "PUBLISHED" && (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-900/40">
                                        Published
                                      </span>
                                    )}
                                    {job.status === "FAILED" && (
                                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-rose-950 text-rose-400 border border-rose-900/40">
                                        Failed
                                      </span>
                                    )}
                                    {job.retryCount > 0 && (
                                      <span className="ml-1.5 text-[10px] text-amber-500 font-mono">Retry ({job.retryCount})</span>
                                    )}
                                  </td>
                                  <td className="py-4 pl-4 text-right">
                                    <button
                                      onClick={() => handleDeleteJob(job.id)}
                                      className="text-zinc-600 hover:text-rose-500 transition px-2 py-1 rounded hover:bg-rose-500/10 text-xs"
                                    >
                                      Delete
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  
                  {/* Job Details Inspector */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h3 className="text-base font-bold text-white mb-4">Job Diagnostics Console</h3>
                    <div className="space-y-4">
                      {jobs.map((job) => {
                        if (job.status === "FAILED" || job.status === "PUBLISHED") {
                          return (
                            <div key={job.id} className={`p-4 rounded-lg border text-xs font-mono ${
                              job.status === "FAILED" ? "bg-rose-950/20 border-rose-900/40" : "bg-emerald-950/20 border-emerald-900/40"
                            }`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className={`font-bold uppercase ${job.status === "FAILED" ? "text-rose-400" : "text-emerald-400"}`}>
                                  {job.status} - ID: {job.id}
                                </span>
                                <span className="text-zinc-500">{job.fileName}</span>
                              </div>
                              {job.status === "PUBLISHED" && (
                                <p className="text-zinc-300">
                                  ✓ Meta Post ID Link: <a href="#" className="underline text-indigo-400">fb.com/{job.metaPostId}</a>
                                </p>
                              )}
                              {job.status === "FAILED" && (
                                <p className="text-rose-300 whitespace-pre-wrap">
                                  ✗ Error Reason: {job.errorLog}
                                </p>
                              )}
                            </div>
                          );
                        }
                        return null;
                      })}
                      {!jobs.some(j => j.status === "FAILED" || j.status === "PUBLISHED") && (
                        <p className="text-xs text-zinc-500 text-center py-4 italic">
                          No finished or failed jobs to inspect. Run the &quot;Simulate Queue Worker&quot; script to generate execution results.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Simulation Output Monitor Panel */}
                <div className="flex flex-col gap-6">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col flex-1 h-full">
                    <h3 className="text-base font-bold text-white mb-2">Worker Simulation Log</h3>
                    <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
                      Watch background steps execute, including token checks, encryption, chunk streams, and API errors.
                    </p>
                    
                    <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-[11px] leading-relaxed text-zinc-300 flex-1 min-h-[300px] overflow-y-auto max-h-[450px]">
                      {simulationLog.length === 0 ? (
                        <div className="text-zinc-600 italic h-full flex items-center justify-center">
                          Awaiting Worker triggering...
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {simulationLog.map((logLine, idx) => (
                            <div key={idx} className={
                              logLine.includes("ERROR") 
                                ? "text-rose-400 font-semibold" 
                                : logLine.includes("SUCCESS") || logLine.includes("Success")
                                ? "text-emerald-400 font-semibold"
                                : logLine.includes("WARNING")
                                ? "text-amber-400"
                                : "text-zinc-300"
                            }>
                              {logLine}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "publisher" && (
              <div className="space-y-8">
                
                {/* BULK UPLOADER AND INTERVAL CONFIG ROW */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  
                  {/* Bulk Video Direct-to-GCS Dropzone simulation */}
                  <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col justify-between">
                    <div>
                      <h3 className="text-base font-bold text-white mb-2">GCS Upload Dropzone (Simulated)</h3>
                      <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
                        Bulk-select local video files. The application generates secure GCS Signed URLs, authorizing client-side browsers to upload directly to Google Cloud Storage.
                      </p>

                      <div className="border-2 border-dashed border-zinc-800 hover:border-zinc-700/80 rounded-xl py-10 px-8 text-center bg-zinc-950/30 cursor-pointer relative group transition">
                        <input
                          type="file"
                          multiple
                          accept="video/*"
                          onChange={handleFileChange}
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                        />
                        <svg
                          className="h-10 w-10 text-zinc-600 group-hover:text-zinc-500 mx-auto mb-3 transition"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                          />
                        </svg>
                        <span className="block text-sm text-zinc-300 font-semibold mb-1 group-hover:text-white transition">
                          Drag and Drop Videos or Click to Browse
                        </span>
                        <span className="block text-xs text-zinc-500 font-mono">
                          Direct direct-to-bucket pipeline
                        </span>
                      </div>
                    </div>

                    {/* Active Uploading bars */}
                    {uploadingFiles.length > 0 && (
                      <div className="mt-6 border-t border-zinc-800/50 pt-5 space-y-4">
                        <h4 className="text-xs font-mono uppercase tracking-wider text-zinc-400">Active Direct Uploads to GCS</h4>
                        <div className="space-y-3.5">
                          {uploadingFiles.map((uf, idx) => (
                            <div key={idx} className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs">
                              <div className="flex items-center justify-between mb-1.5 font-medium">
                                <span className="text-white truncate max-w-[200px]">{uf.name}</span>
                                <span className="text-indigo-400 font-mono">{uf.progress}% ({uf.size})</span>
                              </div>
                              <div className="w-full bg-zinc-900 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300"
                                  style={{ width: `${uf.progress}%` }}
                                ></div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Fixed Interval spacing scheduler tool */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h3 className="text-base font-bold text-white mb-2">Fixed Interval Scheduler</h3>
                    <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
                      Auto-space draft postings to prevent rate limit restrictions and sequence posts smoothly.
                    </p>

                    <div className="space-y-4">
                      <div>
                        <label className="block text-xs font-mono text-zinc-400 uppercase tracking-wider mb-2">
                          Start Date / Time (Kolkata)
                        </label>
                        <input
                          type="datetime-local"
                          value={intervalStartKolkata}
                          onChange={(e) => setIntervalStartKolkata(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-3.5 text-sm text-white focus:outline-none focus:border-indigo-600 transition"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-mono text-zinc-400 uppercase tracking-wider mb-2">
                          Post Spacing Increment
                        </label>
                        <select
                          value={intervalHours}
                          onChange={(e) => setIntervalHours(parseInt(e.target.value))}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-3.5 text-sm text-white focus:outline-none focus:border-indigo-600 transition"
                        >
                          <option value={1}>Every 1 hour</option>
                          <option value={2}>Every 2 hours</option>
                          <option value={4}>Every 4 hours</option>
                          <option value={6}>Every 6 hours</option>
                          <option value={12}>Every 12 hours</option>
                          <option value={24}>Every 24 hours (1 day)</option>
                        </select>
                      </div>

                      <div className="pt-4">
                        <button
                          onClick={handleApplyIntervals}
                          className="w-full bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-2.5 px-4 rounded-lg text-sm border border-zinc-700/50 hover:border-zinc-600 transition flex items-center justify-center gap-1.5"
                        >
                          Apply to Draft Videos
                        </button>
                        <span className="block text-[10px] text-zinc-500 mt-2 text-center">
                          Applies schedules to all uploads currently in &quot;Draft&quot; state.
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* EDIT SCHEDULING DETAILS FOR UPLOADED FILES */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <h3 className="text-base font-bold text-white mb-1.5">Configure Uploaded Videos</h3>
                  <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                    Set English metadata, select destination page, upload custom thumbnail, and schedule specific posting offsets.
                  </p>

                  <div className="space-y-6">
                    {jobs.map((job) => (
                      <div key={job.id} className="bg-zinc-950 border border-zinc-800 rounded-xl p-6 relative">
                        <button
                          onClick={() => handleDeleteJob(job.id)}
                          className="absolute top-4 right-4 text-xs text-rose-500 hover:underline transition"
                        >
                          Remove Video
                        </button>
                        
                        <div className="flex items-center gap-2 mb-4">
                          <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Video:</span>
                          <span className="text-xs font-mono font-bold text-indigo-400 truncate max-w-xs">{job.fileName}</span>
                          <span className="text-xs text-zinc-600">({job.fileSize})</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded font-mono ml-auto ${
                            job.status === "DRAFT" ? "bg-zinc-900 text-zinc-400" : "bg-indigo-950 text-indigo-400"
                          }`}>
                            Status: {job.status}
                          </span>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                          
                          {/* Left inputs */}
                          <div className="lg:col-span-2 space-y-4">
                            
                            {/* Title (English) */}
                            <div>
                              <div className="flex justify-between items-center mb-1">
                                <label className="block text-xs font-mono text-zinc-400 uppercase">English Video Title</label>
                                {job.englishTitle.length > 255 && (
                                  <span className="text-[10px] text-rose-500 font-semibold font-mono">Title too long! Max 255 chars</span>
                                )}
                                {!isEnglishOnly(job.englishTitle) && (
                                  <span className="text-[10px] text-rose-500 font-semibold font-mono">English letters only!</span>
                                )}
                              </div>
                              <input
                                type="text"
                                value={job.englishTitle}
                                onChange={(e) => handleUpdateJobField(job.id, "englishTitle", e.target.value)}
                                className={`w-full bg-zinc-900 border rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-600 transition ${
                                  (job.englishTitle.length > 255 || !isEnglishOnly(job.englishTitle)) ? "border-rose-900/60" : "border-zinc-800"
                                }`}
                                placeholder="Enter English video title"
                              />
                            </div>

                            {/* Caption & Hashtags */}
                            <div>
                              <div className="flex justify-between items-center mb-1">
                                <label className="block text-xs font-mono text-zinc-400 uppercase">English Caption</label>
                                {!isEnglishOnly(job.englishCaption) && (
                                  <span className="text-[10px] text-rose-500 font-semibold font-mono">English letters only!</span>
                                )}
                              </div>
                              <textarea
                                value={job.englishCaption}
                                rows={2}
                                onChange={(e) => handleUpdateJobField(job.id, "englishCaption", e.target.value)}
                                className={`w-full bg-zinc-900 border rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-600 transition ${
                                  !isEnglishOnly(job.englishCaption) ? "border-rose-900/60" : "border-zinc-800"
                                }`}
                                placeholder="Enter caption in English..."
                              />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                              {/* Hashtags */}
                              <div>
                                <label className="block text-xs font-mono text-zinc-400 uppercase mb-1">Hashtags</label>
                                <input
                                  type="text"
                                  value={job.hashtags}
                                  onChange={(e) => handleUpdateJobField(job.id, "hashtags", e.target.value)}
                                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-600 transition"
                                  placeholder="#Hashtag1 #Hashtag2"
                                />
                              </div>

                              {/* Target Sync Page */}
                              <div>
                                <label className="block text-xs font-mono text-zinc-400 uppercase mb-1">Publish to Facebook Page</label>
                                <select
                                  value={job.pageId}
                                  onChange={(e) => handleUpdateJobField(job.id, "pageId", e.target.value)}
                                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-600 transition"
                                >
                                  {pages.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name} {p.tokenStatus === "Expired" ? "(Expired Token!)" : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          </div>

                          {/* Right inputs (Thumbnail & time) */}
                          <div className="space-y-4">
                            
                            {/* Thumbnail Choice */}
                            <div>
                              <label className="block text-xs font-mono text-zinc-400 uppercase mb-1">Video Thumbnail</label>
                              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-xs flex flex-col gap-2">
                                <div className="text-zinc-400 font-medium">
                                  Mode: <span className="text-zinc-200 font-bold">{job.customThumbnailName ? "Custom Image File" : "Auto Facebook Frame"}</span>
                                </div>
                                
                                {job.customThumbnailName ? (
                                  <div className="flex items-center justify-between text-zinc-400 font-mono text-[10px] bg-zinc-950/40 p-1.5 rounded">
                                    <span className="truncate max-w-[150px]">{job.customThumbnailName}</span>
                                    <button
                                      onClick={() => handleUpdateJobField(job.id, "customThumbnailName", undefined)}
                                      className="text-rose-400 font-sans font-semibold hover:underline pl-1"
                                    >
                                      Use Default
                                    </button>
                                  </div>
                                ) : (
                                  <div className="relative border border-zinc-850 hover:bg-zinc-800 cursor-pointer rounded py-2 px-3 text-center text-zinc-500 font-medium transition text-[11px]">
                                    Upload Custom JPEG/PNG
                                    <input
                                      type="file"
                                      accept="image/*"
                                      onChange={(e) => {
                                        if (e.target.files?.[0]) {
                                          handleUpdateJobField(job.id, "customThumbnailName", e.target.files[0].name);
                                          addSecurityLog("INFO", `Uploaded custom thumbnail frame ${e.target.files[0].name} directly to GCS mock staging bucket for Job ID ${job.id}`);
                                        }
                                      }}
                                      className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                    />
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Scheduled Time */}
                            <div>
                              <label className="block text-xs font-mono text-zinc-400 uppercase mb-1">
                                Schedule Publish (Kolkata Time)
                              </label>
                              <input
                                type="datetime-local"
                                value={job.scheduledTimeKolkata}
                                onChange={(e) => {
                                  handleUpdateJobField(job.id, "scheduledTimeKolkata", e.target.value);
                                  handleUpdateJobField(job.id, "status", "SCHEDULED"); // Promoted to Scheduled when scheduled time is set/modified
                                }}
                                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-600 transition"
                              />
                              <div className="text-[10px] font-mono text-zinc-500 mt-2 space-y-0.5">
                                <div>Internal Storage: UTC</div>
                                <div className="text-zinc-400 truncate">Value: {job.scheduledTimeUTC ? formatDateTime(job.scheduledTimeUTC) + "Z" : "Awaiting..."}</div>
                              </div>
                            </div>
                          </div>

                        </div>
                      </div>
                    ))}
                    {jobs.length === 0 && (
                      <div className="text-center py-10 text-zinc-600 bg-zinc-950/20 border border-dashed border-zinc-800 rounded-xl">
                        Awaiting video uploads to display editing forms.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === "pages" && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                
                {/* Meta sync action header */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 border-b border-zinc-800/80 pb-5">
                  <div>
                    <h3 className="text-base font-bold text-white mb-1">Connected Pages ({countPages})</h3>
                    <p className="text-xs text-zinc-500">
                      Manage connected credentials and monitor authorization token statuses.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleSyncPages}
                      disabled={isSyncingPages}
                      className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-zinc-800 disabled:text-zinc-500 font-semibold text-xs text-white py-2.5 px-4 rounded-lg transition shadow-md shadow-indigo-600/10 flex items-center justify-center gap-1.5"
                    >
                      {isSyncingPages ? (
                        <>
                          <span className="animate-spin h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full"></span>
                          Syncing...
                        </>
                      ) : (
                        "Sync Facebook Pages"
                      )}
                    </button>
                  </div>
                </div>

                {/* Grid list of connected pages */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {pages.map((page) => (
                    <div
                      key={page.id}
                      className={`bg-zinc-950 border rounded-xl p-5 hover:border-zinc-700 transition flex flex-col justify-between min-h-[160px] ${
                        page.tokenStatus === "Expired" ? "border-rose-900/60" : "border-zinc-800"
                      }`}
                    >
                      <div className="flex items-start gap-4">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={page.pictureUrl}
                          alt={page.name}
                          className="h-11 w-11 rounded-lg bg-zinc-800 object-cover flex-shrink-0"
                        />
                        <div className="min-w-0">
                          <h4 className="font-semibold text-sm text-white truncate">{page.name}</h4>
                          <span className="block text-[10px] text-zinc-500 mt-0.5">{page.category}</span>
                          <span className="block text-[10px] font-mono text-zinc-500 mt-0.5">ID: {page.id}</span>
                        </div>
                      </div>

                      <div className="mt-5 pt-4 border-t border-zinc-900 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${
                            page.tokenStatus === "Expired" ? "bg-rose-500" : "bg-emerald-400"
                          }`}></span>
                          <span className={`font-mono text-[11px] ${
                            page.tokenStatus === "Expired" ? "text-rose-400 font-semibold" : "text-emerald-400"
                          }`}>
                            Token: {page.tokenStatus}
                          </span>
                        </div>

                        {page.tokenStatus === "Expired" ? (
                          <button
                            onClick={() => handleReconnectAccount(page.id)}
                            className="bg-rose-650 hover:bg-rose-600 text-white font-bold text-[10px] px-3 py-1 rounded transition"
                          >
                            Reconnect
                          </button>
                        ) : (
                          <span className="text-[10px] text-zinc-600 font-mono">
                            Permanent Access Token
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Security warning card */}
                <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-5 mt-8 flex gap-4">
                  <div className="h-10 w-10 rounded-lg bg-indigo-650/15 flex items-center justify-center text-indigo-400 flex-shrink-0">
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m0-8v6m0 5h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <h5 className="text-xs font-bold text-white mb-0.5 uppercase tracking-wider font-mono">Security Model Compliance Notice</h5>
                    <p className="text-xs text-zinc-400 leading-relaxed max-w-4xl">
                      Facebook User and Page access tokens are stored in the database encrypted with AES-256-GCM. 
                      Plain text tokens are completely isolated on the server-side, never rendering in client-side code, cookies, or browser variables. 
                      Logs do not print keys, preventing exposure in crash reports or server telemetry.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "logs" && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-800 pb-4">
                  <div>
                    <h3 className="text-base font-bold text-white mb-1">Security Audit Log Console</h3>
                    <p className="text-xs text-zinc-500">
                      Real-time mock operations output. Observe token encryption tags and parameter sanitization.
                    </p>
                  </div>
                  <button
                    onClick={() => setSecurityLogs([])}
                    className="text-xs text-zinc-400 hover:text-white transition px-2.5 py-1 rounded border border-zinc-850 hover:bg-zinc-800"
                  >
                    Clear Logs
                  </button>
                </div>

                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-5 font-mono text-xs text-zinc-300 min-h-[400px] overflow-y-auto space-y-2">
                  {securityLogs.length === 0 ? (
                    <p className="text-zinc-600 italic text-center py-10">No logs generated.</p>
                  ) : (
                    securityLogs.map((log, idx) => (
                      <div key={idx} className="flex items-start gap-4">
                        <span className="text-zinc-600 flex-shrink-0">[{formatDateTime(log.timestampUTC)}]</span>
                        <span className={`font-bold flex-shrink-0 ${
                          log.level === "ERROR" ? "text-rose-500" : log.level === "WARN" ? "text-amber-500" : "text-indigo-400"
                        }`}>
                          {log.level}
                        </span>
                        <span className="text-zinc-300 leading-relaxed">{log.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            
          </div>
        </main>
      </div>
    </div>
  );
}
