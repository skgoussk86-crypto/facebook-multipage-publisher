"use client";

import React, { useState, useRef, useEffect } from "react";

// Types
interface FacebookPage {
  id: string;
  name: string;
  category: string;
  pictureUrl: string;
  tokenStatus: "Valid" | "Expired";
  connectedAt: string;
}

type JobStatus =
  | "DRAFT"
  | "MEDIA_UPLOADED"
  | "SCHEDULED"
  | "PREPARING"
  | "UPLOADING_TO_META"
  | "META_PROCESSING"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT"
  | "CANCELLED"
  | "FACEBOOK_RECONNECT_REQUIRED";

interface PublishAttempt {
  attemptNumber: number;
  startTime: string;
  completionTime: string;
  errorCode: string | null;
  explanation: string;
  resultingState: JobStatus;
}

interface VideoJob {
  id: string;
  fileName: string;
  fileSize: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  uploadProgress: number; // 0 to 100
  pageId: string;
  contentType: "VIDEO" | "REEL";
  englishTitle: string;
  englishCaption: string;
  hashtags: string;
  scheduledTimeKolkata: string; // "YYYY-MM-DDTHH:MM"
  scheduledTimeUTC: string;
  status: JobStatus;
  metaPostId?: string;
  retryCount: number;
  errorLog?: string;
  thumbnailMode: "auto" | "custom" | "captured";
  customThumbnailUrl?: string; // local url of uploaded thumbnail
  capturedThumbnailUrl?: string; // local data url of captured frame
  localVideoUrl?: string; // local object URL of the video
  attempts?: PublishAttempt[];
}

interface SecurityLog {
  timestampUTC: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  jobId?: string;
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
    fileSizeBytes: 47400000,
    durationSeconds: 120,
    uploadProgress: 100,
    pageId: "1029384756",
    contentType: "VIDEO",
    englishTitle: "Top 5 AI Tools of 2026 You Must Use",
    englishCaption: "AI is evolving rapidly. Here are the tools to boost your productivity this year.",
    hashtags: "#AITools #Productivity #TechTrends",
    scheduledTimeKolkata: "2026-07-12T19:30",
    scheduledTimeUTC: "2026-07-12T14:00:00.000Z",
    status: "SCHEDULED",
    retryCount: 0,
    thumbnailMode: "auto",
  },
  {
    id: "job-2",
    fileName: "gaming_highlights_ep12.mp4",
    fileSize: "128.5 MB",
    fileSizeBytes: 134700000,
    durationSeconds: 300,
    uploadProgress: 100,
    pageId: "5647382910",
    contentType: "REEL",
    englishTitle: "Clutch 1v4 Outplay in Finals",
    englishCaption: "Unbelievable victory in the final round of the tourney. Drop a like!",
    hashtags: "#ClutchGaming #FinalsOutplay #FPSGames",
    scheduledTimeKolkata: "2026-07-12T21:30",
    scheduledTimeUTC: "2026-07-12T16:00:00.000Z",
    status: "SCHEDULED",
    retryCount: 0,
    thumbnailMode: "auto",
  },
];

export default function Home() {
  // Navigation State
  const [activeTab, setActiveTab] = useState<"dashboard" | "publisher" | "pages" | "logs">("dashboard");
  const [systemTimeStr, setSystemTimeStr] = useState("2026-07-12 19:42:24");

  // Core Persistent States
  const [pages, setPages] = useState<FacebookPage[]>(INITIAL_PAGES);
  const [jobs, setJobs] = useState<VideoJob[]>(INITIAL_JOBS);
  const [securityLogs, setSecurityLogs] = useState<SecurityLog[]>([
    { timestampUTC: "2026-07-12T11:30:00Z", level: "INFO", message: "System initialized in Mock Meta Mode." },
    { timestampUTC: "2026-07-12T11:31:05Z", level: "INFO", message: "Loaded 3 Facebook Pages from database schema (Mock)." },
    { timestampUTC: "2026-07-12T11:32:10Z", level: "INFO", message: "Loaded initial scheduled mock video jobs." },
  ]);

  // UI Simulation States
  const [isSyncingPages, setIsSyncingPages] = useState(false);
  const [simulateTokenExpiry, setSimulateTokenExpiry] = useState(false);
  const [simulatingPublish, setSimulatingPublish] = useState(false);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);
  const [simulationScenario, setSimulationScenario] = useState<"success" | "network_failure" | "meta_processing_delay" | "rate_limit" | "invalid_format" | "revoked_token" | "missing_permission">("success");
  const [countdownJobs, setCountdownJobs] = useState<Record<string, number>>({});
  const [selectedHistoryJob, setSelectedHistoryJob] = useState<VideoJob | null>(null);
  const [historyModalTab, setHistoryModalTab] = useState<"attempts" | "audit">("attempts");
  const [simulatingJobId, setSimulatingJobId] = useState<string | null>(null);

  // Filter States
  const [filterPageId, setFilterPageId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterFilename, setFilterFilename] = useState<string>("");
  const [filterDate, setFilterDate] = useState<string>("");

  const getStatusBadge = (status: JobStatus) => {
    switch (status) {
      case "DRAFT":
        return "bg-zinc-800 text-zinc-400 border border-zinc-700/30";
      case "MEDIA_UPLOADED":
        return "bg-blue-950/80 text-blue-400 border border-blue-900/40";
      case "SCHEDULED":
        return "bg-indigo-950/80 text-indigo-400 border border-indigo-900/40";
      case "PREPARING":
        return "bg-purple-950/80 text-purple-400 border border-purple-900/40 animate-pulse";
      case "UPLOADING_TO_META":
        return "bg-cyan-950/80 text-cyan-400 border border-cyan-900/40 animate-pulse";
      case "META_PROCESSING":
        return "bg-amber-950/30 text-amber-400 border border-amber-900/40 animate-pulse";
      case "PUBLISHING":
        return "bg-amber-950/80 text-amber-400 border border-amber-900/40 animate-pulse";
      case "PUBLISHED":
        return "bg-emerald-950/80 text-emerald-400 border border-emerald-900/40";
      case "FAILED_RETRYABLE":
        return "bg-amber-900/20 text-amber-500 border border-amber-700/30";
      case "FAILED_PERMANENT":
        return "bg-rose-950/80 text-rose-400 border border-rose-900/40";
      case "CANCELLED":
        return "bg-zinc-900 text-zinc-500 border border-zinc-800";
      case "FACEBOOK_RECONNECT_REQUIRED":
        return "bg-rose-950/90 text-rose-500 border border-rose-900/80 animate-pulse";
      default:
        return "bg-zinc-850 text-zinc-400 border border-zinc-800";
    }
  };

  const getStatusLabel = (status: JobStatus) => {
    switch (status) {
      case "DRAFT": return "Draft";
      case "MEDIA_UPLOADED": return "Media Uploaded";
      case "SCHEDULED": return "Scheduled";
      case "PREPARING": return "Preparing";
      case "UPLOADING_TO_META": return "Uploading to Meta";
      case "META_PROCESSING": return "Meta Processing";
      case "PUBLISHING": return "Publishing";
      case "PUBLISHED": return "Published";
      case "FAILED_RETRYABLE": return "Failed (Retryable)";
      case "FAILED_PERMANENT": return "Failed (Permanent)";
      case "CANCELLED": return "Cancelled";
      case "FACEBOOK_RECONNECT_REQUIRED": return "Reconnect Required";
      default: return status;
    }
  };

  // Filtered jobs calculation
  const filteredJobs = jobs.filter((job) => {
    if (filterPageId !== "all" && job.pageId !== filterPageId) {
      return false;
    }
    if (filterStatus !== "all" && job.status !== filterStatus) {
      return false;
    }
    if (filterFilename.trim() !== "") {
      const query = filterFilename.toLowerCase();
      const matchFile = job.fileName.toLowerCase().includes(query);
      const matchTitle = job.englishTitle.toLowerCase().includes(query);
      if (!matchFile && !matchTitle) {
        return false;
      }
    }
    if (filterDate !== "") {
      if (!job.scheduledTimeKolkata.startsWith(filterDate)) {
        return false;
      }
    }
    return true;
  });

  // ==========================================
  // PHASE 2: WORKSPACE STATE
  // ==========================================
  const [tempJobsQueue, setTempJobsQueue] = useState<VideoJob[]>([]);
  const [maxFileSizeMB, setMaxFileSizeMB] = useState(500);
  const [fileUploadError, setFileUploadError] = useState<string | null>(null);

  // Bulk Actions
  const [bulkCaption, setBulkCaption] = useState("");
  const [bulkHashtags, setBulkHashtags] = useState("");
  const [bulkPageId, setBulkPageId] = useState(INITIAL_PAGES[0]?.id || "");
  const [bulkContentType, setBulkContentType] = useState<"VIDEO" | "REEL">("VIDEO");

  // Scheduling inputs
  const [schedulingMode, setSchedulingMode] = useState<"individual" | "interval" | "slots">("individual");
  const [intervalStartKolkata, setIntervalStartKolkata] = useState("2026-07-13T09:00");
  const [intervalHours, setIntervalHours] = useState(2);
  const [dailySlotsStartDate, setDailySlotsStartDate] = useState("2026-07-13");
  const [dailyTimeSlots, setDailyTimeSlots] = useState<string[]>(["09:00", "15:00", "21:00"]);
  const [newSlotInput, setNewSlotInput] = useState("");

  // CSV Import/Validation States
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvSuccessCount, setCsvSuccessCount] = useState<number>(0);
  
  // Confirmation Modal
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);

  // Local Thumbnail Capture states
  const [activeFrameCaptureJobId, setActiveFrameCaptureJobId] = useState<string | null>(null);
  const [frameCaptureTime, setFrameCaptureTime] = useState(0);
  const [frameCaptureDuration, setFrameCaptureDuration] = useState(1);
  const [frameCaptureUrl, setFrameCaptureUrl] = useState("");
  const videoCaptureRef = useRef<HTMLVideoElement>(null);

  // System Time Reference (display only)
  const SYSTEM_TIME_STR = systemTimeStr;

  // Timezone display helpers
  const kolkataOffsetStr = "UTC+05:30 (Asia/Kolkata)";

  // Helper to format a Date object as a local Kolkata datetime-local string (YYYY-MM-DDTHH:MM)
  const formatKolkataDatetimeLocal = (date: Date): string => {
    const tzOffsetMs = 5.5 * 60 * 60 * 1000;
    const kolkataDate = new Date(date.getTime() + tzOffsetMs);
    return kolkataDate.getUTCFullYear() + '-' +
      String(kolkataDate.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(kolkataDate.getUTCDate()).padStart(2, '0') + 'T' +
      String(kolkataDate.getUTCHours()).padStart(2, '0') + ':' +
      String(kolkataDate.getUTCMinutes()).padStart(2, '0');
  };

  // Format local Kolkata string into UTC ISO timestamp
  const convertKolkataToUTC = (kolkataTimeStr: string): string => {
    if (!kolkataTimeStr) return "";
    const hasTimezoneIndicator = kolkataTimeStr.includes("+") || kolkataTimeStr.endsWith("Z") || (kolkataTimeStr.includes("T") && kolkataTimeStr.split("T")[1]?.includes("-"));
    const date = new Date(kolkataTimeStr + (hasTimezoneIndicator ? "" : "+05:30"));
    return date.toISOString();
  };

  // Convert Date object/string to clean display string
  const formatDateTime = (isoString: string) => {
    return isoString.replace("T", " ").substring(0, 16);
  };

  const addSecurityLog = (level: "INFO" | "WARN" | "ERROR", message: string, jobId?: string) => {
    const newLog: SecurityLog = {
      timestampUTC: new Date().toISOString(),
      level,
      message,
      jobId,
    };
    setSecurityLogs((prev) => [newLog, ...prev]);
  };

  const isEnglishOnly = (text: string): boolean => {
    const englishRegex = /^[a-zA-Z0-9\s.,!@#$&*()_\-+=\[\]{}|\\\/;:'"?%]*$/;
    return englishRegex.test(text);
  };

  // Validate single job
  const getJobValidationErrors = (job: VideoJob, currentQueue: VideoJob[]): string[] => {
    const errors: string[] = [];

    // Title checks
    if (!job.englishTitle.trim()) {
      errors.push("Title is required.");
    } else if (job.englishTitle.length > 255) {
      errors.push("Title exceeds Meta limit of 255 characters.");
    } else if (!isEnglishOnly(job.englishTitle)) {
      errors.push("Title must be in English characters only.");
    }

    // Caption checks
    if (job.englishCaption && !isEnglishOnly(job.englishCaption)) {
      errors.push("Caption must contain English text only.");
    }

    // File type limits
    const ext = job.fileName.substring(job.fileName.lastIndexOf(".")).toLowerCase();
    if (ext !== ".mp4" && ext !== ".mov") {
      errors.push("Unsupported file type. Only MP4 and MOV are allowed.");
    }

    // File size limits
    const sizeInMB = job.fileSizeBytes / (1024 * 1024);
    if (sizeInMB > maxFileSizeMB) {
      errors.push(`File exceeds maximum configured size of ${maxFileSizeMB} MB.`);
    }

    // Duplicate check in this upload queue
    const duplicates = currentQueue.filter((q) => q.fileName === job.fileName);
    if (duplicates.length > 1) {
      errors.push("Duplicate filename in this bulk upload batch.");
    }

    // Date/Time validation
    if (!job.scheduledTimeKolkata) {
      errors.push("Scheduled publishing date/time is required.");
    } else {
      const scheduledMs = new Date(job.scheduledTimeKolkata + "+05:30").getTime();
      const currentMs = Date.now();
      if (scheduledMs <= currentMs) {
        errors.push("Publishing time must be in the future.");
      }
    }

    return errors;
  };

  // Drag and Drop/Picker File Selection handler
  const handleBulkFilesSelect = (filesList: FileList) => {
    setFileUploadError(null);
    const filesArray = Array.from(filesList);

    filesArray.forEach((file) => {
      const ext = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      if (ext !== ".mp4" && ext !== ".mov") {
        setFileUploadError(`File "${file.name}" rejected: Only MP4 and MOV formats are supported.`);
        return;
      }

      const sizeMB = (file.size / (1024 * 1024)).toFixed(1) + " MB";
      const localUrl = URL.createObjectURL(file);

      // Create a temporary job object with DRAFT status
      const tempId = "temp-" + Math.random().toString(36).substr(2, 9);
      const newJob: VideoJob = {
        id: tempId,
        fileName: file.name,
        fileSize: sizeMB,
        fileSizeBytes: file.size,
        uploadProgress: 0,
        pageId: pages[0]?.id || "",
        contentType: "VIDEO",
        englishTitle: file.name.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "),
        englishCaption: "",
        hashtags: "",
        scheduledTimeKolkata: "",
        scheduledTimeUTC: "",
        status: "DRAFT",
        retryCount: 0,
        thumbnailMode: "auto",
        localVideoUrl: localUrl,
      };

      setTempJobsQueue((prev) => [...prev, newJob]);

      // Mock Local Upload Progress & metadata scanning
      let progress = 0;
      const interval = setInterval(() => {
        progress += 25;
        setTempJobsQueue((prev) =>
          prev.map((j) => (j.id === tempId ? { ...j, uploadProgress: progress, status: progress >= 100 ? "MEDIA_UPLOADED" : "DRAFT" } : j))
        );

        if (progress >= 100) {
          clearInterval(interval);
          
          // Probe video duration programmatically
          const videoElement = document.createElement("video");
          videoElement.src = localUrl;
          videoElement.onloadedmetadata = () => {
            setTempJobsQueue((prev) =>
              prev.map((j) =>
                j.id === tempId
                  ? { ...j, durationSeconds: Math.round(videoElement.duration), status: "MEDIA_UPLOADED" }
                  : j
              )
            );
          };
          
          addSecurityLog("INFO", `Mock upload complete for ${file.name}. Cached local Object URL. Job status transitioned to MEDIA_UPLOADED.`, tempId);
        }
      }, 300);
    });
  };

  // File Picker wrapper
  const triggerPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleBulkFilesSelect(e.target.files);
    }
  };

  // Drag over handler
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // Drop handler
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      handleBulkFilesSelect(e.dataTransfer.files);
    }
  };

  // Update fields inside publisher queue
  const handleUpdateTempJobField = (jobId: string, field: keyof VideoJob, value: string | number | boolean | undefined) => {
    setTempJobsQueue((prev) =>
      prev.map((job) => {
        if (job.id !== jobId) return job;
        const updated = { ...job, [field]: value };
        if (field === "scheduledTimeKolkata") {
          updated.scheduledTimeUTC = convertKolkataToUTC(value as string);
        }
        return updated;
      })
    );
  };

  // Delete draft from queue
  const handleDeleteDraft = (id: string) => {
    setTempJobsQueue((prev) => prev.filter((j) => j.id !== id));
  };

  // ==========================================
  // BULK ACTIONS
  // ==========================================
  const handleApplyCaptionToAll = () => {
    setTempJobsQueue((prev) => prev.map((j) => ({ ...j, englishCaption: bulkCaption })));
    addSecurityLog("INFO", `Bulk applied caption to all ${tempJobsQueue.length} draft items.`);
  };

  const handleAppendHashtagsToAll = () => {
    setTempJobsQueue((prev) =>
      prev.map((j) => {
        const cleanedJobHash = j.hashtags ? j.hashtags.trim() : "";
        const cleanedBulkHash = bulkHashtags ? bulkHashtags.trim() : "";
        return {
          ...j,
          hashtags: cleanedJobHash ? `${cleanedJobHash} ${cleanedBulkHash}` : cleanedBulkHash,
        };
      })
    );
    addSecurityLog("INFO", `Bulk appended hashtags to all ${tempJobsQueue.length} draft items.`);
  };

  const handleReplaceHashtagsToAll = () => {
    setTempJobsQueue((prev) => prev.map((j) => ({ ...j, hashtags: bulkHashtags })));
    addSecurityLog("INFO", `Bulk replaced hashtags on all ${tempJobsQueue.length} draft items.`);
  };

  const handleApplyPageToAll = () => {
    setTempJobsQueue((prev) => prev.map((j) => ({ ...j, pageId: bulkPageId })));
    addSecurityLog("INFO", `Bulk assigned page ID ${bulkPageId} to all ${tempJobsQueue.length} draft items.`);
  };

  const handleApplyContentTypeToAll = () => {
    setTempJobsQueue((prev) => prev.map((j) => ({ ...j, contentType: bulkContentType })));
    addSecurityLog("INFO", `Bulk assigned content type ${bulkContentType} to all ${tempJobsQueue.length} draft items.`);
  };

  // ==========================================
  // SCHEDULING MODES
  // ==========================================

  // Daily Slots controls
  const handleAddSlot = () => {
    if (!newSlotInput) return;
    // Basic format validation hh:mm
    const regex = /^([0-9]|0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!regex.test(newSlotInput)) {
      alert("Invalid format. Use 24-hour format HH:MM (e.g. 09:30, 14:00).");
      return;
    }
    
    // Sort times ascending
    const updated = [...dailyTimeSlots, newSlotInput].sort();
    setDailyTimeSlots(updated);
    setNewSlotInput("");
  };

  const handleRemoveSlot = (idx: number) => {
    setDailyTimeSlots((prev) => prev.filter((_, i) => i !== idx));
  };

  // Apply intervals
  const handleApplySchedulingMode = () => {
    if (tempJobsQueue.length === 0) {
      alert("No uploaded videos in the publisher queue to schedule.");
      return;
    }

    if (schedulingMode === "interval") {
      const currentTime = new Date(intervalStartKolkata + "+05:30");
      setTempJobsQueue((prev) => {
        return prev.map((job, idx) => {
          const scheduled = new Date(currentTime.getTime());
          scheduled.setHours(scheduled.getHours() + idx * intervalHours);
          const localStr = formatKolkataDatetimeLocal(scheduled);
          return {
            ...job,
            scheduledTimeKolkata: localStr,
            scheduledTimeUTC: scheduled.toISOString(),
          };
        });
      });
      addSecurityLog("INFO", `Scheduled ${tempJobsQueue.length} videos at ${intervalHours}-hour intervals starting from ${intervalStartKolkata}.`);
    } else if (schedulingMode === "slots") {
      if (dailyTimeSlots.length === 0) {
        alert("Please add at least one daily time slot.");
        return;
      }

      setTempJobsQueue((prev) => {
        let currentDayOffset = 0;
        let slotIndex = 0;

        return prev.map((job) => {
          // Cycle through slots
          if (slotIndex >= dailyTimeSlots.length) {
            slotIndex = 0;
            currentDayOffset++;
          }

          const targetSlotTime = dailyTimeSlots[slotIndex];
          const [hours, minutes] = targetSlotTime.split(":").map(Number);
          
          const scheduled = new Date(dailySlotsStartDate + "T00:00:00+05:30");
          scheduled.setDate(scheduled.getDate() + currentDayOffset);
          scheduled.setHours(hours, minutes, 0, 0);

          const localStr = formatKolkataDatetimeLocal(scheduled);
          slotIndex++;

          return {
            ...job,
            scheduledTimeKolkata: localStr,
            scheduledTimeUTC: scheduled.toISOString(),
          };
        });
      });
      addSecurityLog("INFO", `Scheduled ${tempJobsQueue.length} videos using reusable daily slots starting ${dailySlotsStartDate}.`);
    }
  };

  // ==========================================
  // LOCAL THUMBNAIL FRAME CAPTURING
  // ==========================================
  const handleOpenFrameCaptureModal = (job: VideoJob) => {
    if (!job.localVideoUrl) {
      alert("Local video URL not available. Frame capture is only supported for local uploaded files.");
      return;
    }
    setActiveFrameCaptureJobId(job.id);
    setFrameCaptureUrl(job.localVideoUrl);
    setFrameCaptureTime(0);
    setFrameCaptureDuration(job.durationSeconds || 10);
  };

  // Seek and update frame state
  useEffect(() => {
    if (activeFrameCaptureJobId && videoCaptureRef.current) {
      videoCaptureRef.current.currentTime = frameCaptureTime;
    }
  }, [frameCaptureTime, activeFrameCaptureJobId]);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const kolkataTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const pad = (n: number) => n.toString().padStart(2, "0");
      const formatted = `${kolkataTime.getFullYear()}-${pad(kolkataTime.getMonth() + 1)}-${pad(kolkataTime.getDate())} ${pad(kolkataTime.getHours())}:${pad(kolkataTime.getMinutes())}:${pad(kolkataTime.getSeconds())}`;
      setSystemTimeStr(formatted);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleCaptureFrameAction = () => {
    const video = videoCaptureRef.current;
    if (video && activeFrameCaptureJobId) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 360;
      
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg");
        
        handleUpdateTempJobField(activeFrameCaptureJobId, "capturedThumbnailUrl", dataUrl);
        handleUpdateTempJobField(activeFrameCaptureJobId, "thumbnailMode", "captured");
        
        addSecurityLog("INFO", `Captured dynamic frame at ${frameCaptureTime.toFixed(1)}s from local video file.`);
        setActiveFrameCaptureJobId(null);
      }
    }
  };

  // ==========================================
  // CSV BULK IMPORT ENGINE (RFC-COMPLIANT PARSER)
  // ==========================================
  const handleDownloadCsvTemplate = () => {
    const headers = "filename,title,caption,hashtags,page_id,content_type,publish_time,timezone\n";
    const example1 = `ai_trends_2026.mp4,Top 5 AI Tools of 2026 You Must Use,Explore modern AI integrations,#AITools #Tech,1029384756,Video,2026-07-13 10:00,Asia/Kolkata\n`;
    const example2 = `gaming_highlights_ep12.mp4,Insane 1v4 Outplay,Clutch matches highlight clip,#Gaming #Clutch,5647382910,Reel,2026-07-13 14:00,Asia/Kolkata\n`;
    
    const blob = new Blob([headers + example1 + example2], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "publisher_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Simple RFC-compliant parser
  const parseCSVRows = (text: string): string[][] => {
    const lines = [];
    let row = [""];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];
      if (c === '"') {
        if (inQuotes && next === '"') {
          row[row.length - 1] += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === "," && !inQuotes) {
        row.push("");
      } else if ((c === "\r" || c === "\n") && !inQuotes) {
        if (c === "\r" && next === "\n") {
          i++;
        }
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
    }
    if (row.length > 1 || row[0] !== "") {
      lines.push(row);
    }
    return lines;
  };

  const handleUploadCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const rows = parseCSVRows(text);
      if (rows.length < 2) {
        setCsvErrors(["CSV file is empty or missing headers."]);
        return;
      }

      const headers = rows[0].map(h => h.trim().toLowerCase());
      const expected = ["filename", "title", "caption", "hashtags", "page_id", "content_type", "publish_time", "timezone"];
      
      const missing = expected.filter(exp => !headers.includes(exp));
      if (missing.length > 0) {
        setCsvErrors([`CSV Header mismatch. Missing columns: ${missing.join(", ")}`]);
        return;
      }

      const fnIdx = headers.indexOf("filename");
      const titleIdx = headers.indexOf("title");
      const capIdx = headers.indexOf("caption");
      const hashIdx = headers.indexOf("hashtags");
      const pageIdx = headers.indexOf("page_id");
      const ctIdx = headers.indexOf("content_type");
      const ptIdx = headers.indexOf("publish_time");
      const tzIdx = headers.indexOf("timezone");

      const errorsAccumulator: string[] = [];
      let matchCount = 0;

      // Process each row
      const updatedQueue = [...tempJobsQueue];

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        // Check if row is completely empty/blank line
        const isRowEmpty = row.length === 0 || (row.length === 1 && row[0].trim() === "");
        if (isRowEmpty) continue;

        const filename = row[fnIdx]?.trim() || "";

        if (row.length < expected.length) {
          errorsAccumulator.push(`Row ${r + 1} ${filename ? `(${filename}) ` : ""}- Column count mismatch. Expected ${expected.length} columns, found ${row.length}.`);
          continue;
        }

        const title = row[titleIdx]?.trim();
        const caption = row[capIdx]?.trim();
        const hashtags = row[hashIdx]?.trim();
        const pageId = row[pageIdx]?.trim();
        const contentTypeRaw = row[ctIdx]?.trim().toUpperCase();
        const publishTimeRaw = row[ptIdx]?.trim();
        const timezoneRaw = row[tzIdx]?.trim();

        if (!filename) {
          errorsAccumulator.push(`Row ${r + 1}: Filename cannot be empty.`);
          continue;
        }

        const jobQueueIndex = updatedQueue.findIndex(j => j.fileName === filename);

        if (jobQueueIndex === -1) {
          errorsAccumulator.push(`Row ${r + 1} (${filename}): Filename not found in current publisher upload queue. Select the video file first.`);
          continue;
        }

        const errorsThisRow: string[] = [];

        // Validation - Empty title
        if (!title) {
          errorsThisRow.push("Title cannot be empty.");
        } else if (!isEnglishOnly(title)) {
          errorsThisRow.push("Title must be in English characters.");
        }

        // Validation - Caption
        if (caption && !isEnglishOnly(caption)) {
          errorsThisRow.push("Caption must be in English characters.");
        }

        // Validation - Timezone
        if (!timezoneRaw) {
          errorsThisRow.push("Timezone is required.");
        } else if (timezoneRaw.toLowerCase() !== "asia/kolkata") {
          errorsThisRow.push(`Unsupported timezone '${timezoneRaw}'. Only 'Asia/Kolkata' is supported.`);
        }

        // Validation - Page ID
        const pageExists = pages.some(p => p.id === pageId);
        if (!pageExists) {
          errorsThisRow.push(`Page ID '${pageId}' is not connected.`);
        }

        // Validation - Content Type
        const isReel = contentTypeRaw === "REEL" || contentTypeRaw === "FACEBOOK REEL";
        const isVideo = contentTypeRaw === "VIDEO" || contentTypeRaw === "FACEBOOK VIDEO";
        if (!isReel && !isVideo) {
          errorsThisRow.push(`Invalid content type '${contentTypeRaw}'. Must be 'Video' or 'Reel'.`);
        }

        // Validation - Date parsing
        const dateKolkata = publishTimeRaw ? publishTimeRaw.replace(" ", "T") : "";
        let scheduledMs = NaN;
        if (dateKolkata) {
          const hasTimezoneIndicator = dateKolkata.includes("+") || dateKolkata.endsWith("Z") || (dateKolkata.includes("T") && dateKolkata.split("T")[1]?.includes("-"));
          scheduledMs = new Date(dateKolkata + (hasTimezoneIndicator ? "" : "+05:30")).getTime();
        }

        const currentMs = Date.now();
        if (!publishTimeRaw || isNaN(scheduledMs)) {
          errorsThisRow.push("Invalid scheduled publish time date format.");
        } else if (scheduledMs <= currentMs) {
          errorsThisRow.push("Publishing time must be in the future.");
        }

        if (errorsThisRow.length > 0) {
          errorsAccumulator.push(`Row ${r + 1} (${filename}) Errors: ${errorsThisRow.join(" | ")}`);
        } else {
          // Commit parameters
          updatedQueue[jobQueueIndex] = {
            ...updatedQueue[jobQueueIndex],
            englishTitle: title,
            englishCaption: caption || "",
            hashtags: hashtags || "",
            pageId: pageId,
            contentType: isReel ? "REEL" : "VIDEO",
            scheduledTimeKolkata: dateKolkata,
            scheduledTimeUTC: convertKolkataToUTC(dateKolkata),
          };
          matchCount++;
        }
      }

      setTempJobsQueue(updatedQueue);
      setCsvErrors(errorsAccumulator);
      setCsvSuccessCount(matchCount);
      addSecurityLog("INFO", `Parsed CSV bulk imports: Successfully matched and configured ${matchCount} items. ${errorsAccumulator.length} rows failed validation.`);
    };

    reader.readAsText(file);
  };

  // ==========================================
  // CONFIRMATION AND SAVING PIPELINE
  // ==========================================
  const handleSaveTrigger = () => {
    if (tempJobsQueue.length === 0) {
      alert("No video items in the queue to save.");
      return;
    }

    // Evaluate validations
    const allErrors: string[] = [];
    tempJobsQueue.forEach((job) => {
      const errs = getJobValidationErrors(job, tempJobsQueue);
      if (errs.length > 0) {
        allErrors.push(`File "${job.fileName}": ${errs.join(" | ")}`);
      }
    });

    if (allErrors.length > 0) {
      alert("Validation failed! Please fix all card-level errors before scheduling:\n\n" + allErrors.join("\n"));
      return;
    }

    setIsConfirmationOpen(true);
  };

  const handleConfirmSave = () => {
    // Promote temp queue to active scheduling list
    const confirmedJobs = tempJobsQueue.map((job) => {
      addSecurityLog("INFO", `Job "${job.fileName}" (${job.id}) transitioned from MEDIA_UPLOADED to SCHEDULED.`, job.id);
      return {
        ...job,
        status: "SCHEDULED" as JobStatus,
      };
    });

    setJobs((prev) => [...prev, ...confirmedJobs]);
    setTempJobsQueue([]);
    setIsConfirmationOpen(false);

    addSecurityLog("INFO", `Scheduled ${confirmedJobs.length} new bulk videos into schedule state queue.`);
    setActiveTab("dashboard");
  };

  // Reset Demo Helper (Extended)
  const handleResetDemo = () => {
    setJobs(INITIAL_JOBS);
    setPages(INITIAL_PAGES);
    setTempJobsQueue([]);
    setCsvErrors([]);
    setCsvSuccessCount(0);
    setSimulateTokenExpiry(false);
    setSimulationLog([]);
    setCountdownJobs({});
    addSecurityLog("INFO", "Reset simulator demo state (Phase 3).");
  };

  const startRetryCountdown = (jobId: string, seconds: number, scenario: string) => {
    setCountdownJobs(prev => ({ ...prev, [jobId]: seconds }));

    const interval = setInterval(() => {
      setCountdownJobs(prev => {
        const current = prev[jobId];
        if (current === undefined) {
          clearInterval(interval);
          return prev;
        }
        if (current <= 1) {
          clearInterval(interval);
          
          setJobs(jobsList => jobsList.map(j => {
            if (j.id === jobId) {
              addSecurityLog("INFO", `Job "${j.fileName}" (${jobId}) retry countdown completed. Re-entering queue worker.`, jobId);
              return { ...j, status: "SCHEDULED" as JobStatus };
            }
            return j;
          }));

          // Trigger worker execution
          setTimeout(() => {
            runWorkerForJob(jobId, scenario);
          }, 500);

          const updated = { ...prev };
          delete updated[jobId];
          return updated;
        }
        return { ...prev, [jobId]: current - 1 };
      });
    }, 1000);
  };

  const runWorkerForJob = (targetJobId: string, scenario: string) => {
    // Find the job inside the state snapshot
    setJobs(prevJobs => {
      const job = prevJobs.find(j => j.id === targetJobId);
      if (!job) return prevJobs;

      setSimulatingPublish(true);
      setSimulatingJobId(targetJobId);
      setSimulationLog([`[Worker] Initializing queue worker for job "${job.fileName}"...`]);

      const startTime = new Date().toISOString();

      const transitionState = (nextStatus: JobStatus, logMessage: string, doneCallback?: () => void) => {
        setJobs(currJobs => currJobs.map(j => {
          if (j.id === targetJobId) {
            return { ...j, status: nextStatus };
          }
          return j;
        }));
        setSimulationLog(prev => [...prev, `[Worker] [${nextStatus}] ${logMessage}`]);
        addSecurityLog("INFO", `Job "${job.fileName}" (${targetJobId}) status transitioned to ${nextStatus}.`, targetJobId);
        if (doneCallback) doneCallback();
      };

      // Step 1: PREPARING
      setTimeout(() => {
        transitionState("PREPARING", "Validating video format and metadata standard...");

        // Step 2: Validation checks
        setTimeout(() => {
          const targetPage = pages.find(p => p.id === job.pageId);

          // Scenario checks in PREPARING:
          // Scenario: revoked_token (or if token status is expired already)
          if (scenario === "revoked_token" || targetPage?.tokenStatus === "Expired") {
            const completionTime = new Date().toISOString();
            const attempt: PublishAttempt = {
              attemptNumber: job.retryCount + 1,
              startTime,
              completionTime,
              errorCode: "META_OAUTH_190",
              explanation: "Meta access token revoked or expired. Code 190. Please reconnect account.",
              resultingState: "FACEBOOK_RECONNECT_REQUIRED"
            };

            setPages(currPages => currPages.map(p => p.id === job.pageId ? { ...p, tokenStatus: "Expired" as const } : p));

            setJobs(currJobs => currJobs.map(j => {
              if (j.id === targetJobId) {
                return {
                  ...j,
                  status: "FACEBOOK_RECONNECT_REQUIRED" as JobStatus,
                  errorLog: "Meta API Code 190: Expired Page access token. Re-authorization required.",
                  attempts: [...(j.attempts || []), attempt]
                };
              }
              return j;
            }));

            setSimulationLog(prev => [...prev, "[Worker] [ERROR] Meta API Code 190: Revoked token.", "[Worker] Job transitioned to FACEBOOK_RECONNECT_REQUIRED."]);
            addSecurityLog("ERROR", `Failed executing Job ${targetJobId}: Token expired (Code 190).`, targetJobId);
            setSimulatingPublish(false);
            setSimulatingJobId(null);
            return;
          }

          // Scenario: missing_permission
          if (scenario === "missing_permission") {
            const completionTime = new Date().toISOString();
            const attempt: PublishAttempt = {
              attemptNumber: job.retryCount + 1,
              startTime,
              completionTime,
              errorCode: "META_PERMISSION_DENIED",
              explanation: "Permissions 'pages_manage_posts' or 'publish_video' are missing for this page.",
              resultingState: "FAILED_PERMANENT"
            };

            setJobs(currJobs => currJobs.map(j => {
              if (j.id === targetJobId) {
                return {
                  ...j,
                  status: "FAILED_PERMANENT" as JobStatus,
                  errorLog: "Meta API Code 200: Permission Denied. Ensure pages_manage_posts is granted.",
                  attempts: [...(j.attempts || []), attempt]
                };
              }
              return j;
            }));

            setSimulationLog(prev => [...prev, "[Worker] [ERROR] Meta API Code 200: Missing permission.", "[Worker] Job transitioned to FAILED_PERMANENT."]);
            addSecurityLog("ERROR", `Failed executing Job ${targetJobId}: Missing Page permission (Code 200).`, targetJobId);
            setSimulatingPublish(false);
            setSimulatingJobId(null);
            return;
          }

          // Scenario: invalid_format
          if (scenario === "invalid_format") {
            const completionTime = new Date().toISOString();
            const attempt: PublishAttempt = {
              attemptNumber: job.retryCount + 1,
              startTime,
              completionTime,
              errorCode: "INVALID_VIDEO_FORMAT",
              explanation: "Video file uses unsupported container, aspect ratio, or audio channels.",
              resultingState: "FAILED_PERMANENT"
            };

            setJobs(currJobs => currJobs.map(j => {
              if (j.id === targetJobId) {
                return {
                  ...j,
                  status: "FAILED_PERMANENT" as JobStatus,
                  errorLog: "Validation Error: Invalid video format container/aspect ratio.",
                  attempts: [...(j.attempts || []), attempt]
                };
              }
              return j;
            }));

            setSimulationLog(prev => [...prev, "[Worker] [ERROR] Validation: Invalid video container format.", "[Worker] Job transitioned to FAILED_PERMANENT."]);
            addSecurityLog("ERROR", `Failed executing Job ${targetJobId}: Invalid video format.`, targetJobId);
            setSimulatingPublish(false);
            setSimulatingJobId(null);
            return;
          }

          // Proceeding to UPLOADING_TO_META
          transitionState("UPLOADING_TO_META", "Streaming raw video chunks to Facebook Graph API reels endpoint...");

          setTimeout(() => {
            // Scenario: network_failure (on attempt 1)
            if (scenario === "network_failure" && job.retryCount === 0) {
              const completionTime = new Date().toISOString();
              const attempt: PublishAttempt = {
                attemptNumber: 1,
                startTime,
                completionTime,
                errorCode: "NET_TIMEOUT",
                explanation: "Connection timed out during file chunk upload stream.",
                resultingState: "FAILED_RETRYABLE"
              };

              setJobs(currJobs => currJobs.map(j => {
                if (j.id === targetJobId) {
                  return {
                    ...j,
                    status: "FAILED_RETRYABLE" as JobStatus,
                    retryCount: 1,
                    errorLog: "Network Timeout: Connection lost during stream upload.",
                    attempts: [...(j.attempts || []), attempt]
                  };
                }
                return j;
              }));

              setSimulationLog(prev => [...prev, "[Worker] [ERROR] Network Timeout. Transitioned to FAILED_RETRYABLE.", "[Worker] Initiating automatic retry countdown..."]);
              addSecurityLog("WARN", `Job ${targetJobId} failed temporarily: Connection timeout. Preparing retry...`, targetJobId);
              setSimulatingPublish(false);
              setSimulatingJobId(null);

              // Trigger retry countdown of 4 seconds
              startRetryCountdown(targetJobId, 4, scenario);
              return;
            }

            // Proceeding to META_PROCESSING
            transitionState("META_PROCESSING", "Waiting for Facebook backend transcoding & processing queue...");

            setTimeout(() => {
              // Scenario: meta_processing_delay (on attempt 1)
              if (scenario === "meta_processing_delay" && job.retryCount === 0) {
                const completionTime = new Date().toISOString();
                const attempt: PublishAttempt = {
                  attemptNumber: 1,
                  startTime,
                  completionTime,
                  errorCode: "META_PROCESSING_TIMEOUT",
                  explanation: "Meta took longer than 60 seconds to process video encoding.",
                  resultingState: "FAILED_RETRYABLE"
                };

                setJobs(currJobs => currJobs.map(j => {
                  if (j.id === targetJobId) {
                    return {
                      ...j,
                      status: "FAILED_RETRYABLE" as JobStatus,
                      retryCount: 1,
                      errorLog: "API Timeout: Meta processing delay exceeded thresholds.",
                      attempts: [...(j.attempts || []), attempt]
                    };
                  }
                  return j;
                }));

                setSimulationLog(prev => [...prev, "[Worker] [ERROR] Meta processing delay exceeded. Transitioned to FAILED_RETRYABLE.", "[Worker] Initiating automatic retry countdown..."]);
                addSecurityLog("WARN", `Job ${targetJobId} failed temporarily: Meta processing timeout. Preparing retry...`, targetJobId);
                setSimulatingPublish(false);
                setSimulatingJobId(null);

                startRetryCountdown(targetJobId, 4, scenario);
                return;
              }

              // Proceeding to PUBLISHING
              transitionState("PUBLISHING", "Sending final publish confirmation payload to Page node...");

              setTimeout(() => {
                // Scenario: rate_limit (fails on attempts 1 and 2, succeeds on attempt 3)
                if (scenario === "rate_limit" && job.retryCount < 2) {
                  const currentAttempt = job.retryCount + 1;
                  const completionTime = new Date().toISOString();
                  const attempt: PublishAttempt = {
                    attemptNumber: currentAttempt,
                    startTime,
                    completionTime,
                    errorCode: "META_RATE_LIMIT",
                    explanation: `Graph API rate limit exceeded (Code 4). Calls restricted.`,
                    resultingState: "FAILED_RETRYABLE"
                  };

                  setJobs(currJobs => currJobs.map(j => {
                    if (j.id === targetJobId) {
                      return {
                        ...j,
                        status: "FAILED_RETRYABLE" as JobStatus,
                        retryCount: currentAttempt,
                        errorLog: `Rate Limit Exceeded (Code 4). Attempt ${currentAttempt}/3 failed.`,
                        attempts: [...(j.attempts || []), attempt]
                      };
                    }
                    return j;
                  }));

                  setSimulationLog(prev => [...prev, `[Worker] [ERROR] Rate limit reached. Transitioned to FAILED_RETRYABLE.`, `[Worker] Initiating automatic retry countdown...`]);
                  addSecurityLog("WARN", `Job ${targetJobId} failed temporarily: Rate limit. Preparing retry...`, targetJobId);
                  setSimulatingPublish(false);
                  setSimulatingJobId(null);

                  startRetryCountdown(targetJobId, 4, scenario);
                  return;
                }

                // Success! PUBLISHED
                const mockPostId = Math.floor(1000000000000 + Math.random() * 9000000000000).toString();
                const completionTime = new Date().toISOString();
                const attempt: PublishAttempt = {
                  attemptNumber: job.retryCount + 1,
                  startTime,
                  completionTime,
                  errorCode: null,
                  explanation: `Successfully published to Page. Post ID: ${mockPostId}`,
                  resultingState: "PUBLISHED"
                };

                setJobs(currJobs => currJobs.map(j => {
                  if (j.id === targetJobId) {
                    return {
                      ...j,
                      status: "PUBLISHED" as JobStatus,
                      metaPostId: mockPostId,
                      attempts: [...(j.attempts || []), attempt]
                    };
                  }
                  return j;
                }));

                setSimulationLog(prev => [
                  ...prev,
                  `[Worker] Success! Published video to page. Facebook Post ID: ${mockPostId}`,
                  `[Worker] Job transitioned to PUBLISHED.`
                ]);
                addSecurityLog("INFO", `Job "${job.fileName}" (${targetJobId}) successfully published. Post ID: ${mockPostId}`, targetJobId);
                setSimulatingPublish(false);
                setSimulatingJobId(null);

              }, 1000); // PUBLISHING delay

            }, 1500); // META_PROCESSING delay

          }, 1200); // UPLOADING_TO_META delay

        }, 1000); // PREPARING checks delay

      }, 1000); // PREPARING state transition

      return prevJobs;
    });
  };

  const handleSimulateQueueWorker = () => {
    const pendingJobs = jobs.filter((j) => j.status === "SCHEDULED" || j.status === "FAILED_RETRYABLE");
    if (pendingJobs.length === 0) {
      setSimulationLog(["No SCHEDULED or retryable jobs found to execute."]);
      return;
    }
    
    // Pick the first one
    const targetJob = pendingJobs[0];
    runWorkerForJob(targetJob.id, simulationScenario);
  };

  const handleSyncPages = () => {
    setIsSyncingPages(true);
    addSecurityLog("INFO", "Initiated managed Facebook Pages synchronization request.");
    
    setTimeout(() => {
      setIsSyncingPages(false);
      setPages(
        INITIAL_PAGES.map((page) => ({
          ...page,
          tokenStatus: simulateTokenExpiry ? "Expired" : "Valid",
        }))
      );
      addSecurityLog("INFO", `Fetched ${INITIAL_PAGES.length} pages from Meta Graph API. Tokens encrypted and saved.`);
    }, 1500);
  };

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

  const handleReconnectAccount = (pageId: string) => {
    setPages((prev) =>
      prev.map((page) => (page.id === pageId ? { ...page, tokenStatus: "Valid" } : page))
    );
    setJobs((prev) =>
      prev.map((j) => {
        if (j.pageId === pageId && j.status === "FACEBOOK_RECONNECT_REQUIRED") {
          addSecurityLog("INFO", `Token reconnected. Job "${j.fileName}" (${j.id}) reset from FACEBOOK_RECONNECT_REQUIRED to SCHEDULED.`, j.id);
          return { ...j, status: "SCHEDULED" as JobStatus };
        }
        return j;
      })
    );
    addSecurityLog("INFO", `Reconnected Page Access Token for Page ID: ${pageId} via Mock OAuth.`);
  };

  const handleReconnectAll = () => {
    setPages(prev => prev.map(p => ({ ...p, tokenStatus: "Valid" as const })));
    setJobs(prev => prev.map(j => {
      if (j.status === "FACEBOOK_RECONNECT_REQUIRED") {
        addSecurityLog("INFO", `Token reconnected. Job "${j.fileName}" (${j.id}) reset from FACEBOOK_RECONNECT_REQUIRED to SCHEDULED.`, j.id);
        return { ...j, status: "SCHEDULED" as JobStatus };
      }
      return j;
    }));
    addSecurityLog("INFO", "Reconnected all expired Facebook Pages via mock OAuth.");
  };

  const handleCancelJob = (jobId: string) => {
    // Clear countdown if any
    setCountdownJobs(prev => {
      const updated = { ...prev };
      delete updated[jobId];
      return updated;
    });

    setJobs(prev => prev.map(j => {
      if (j.id === jobId) {
        addSecurityLog("INFO", `Job "${j.fileName}" (${jobId}) was cancelled by the administrator. Status transitioned to CANCELLED.`, jobId);
        return { ...j, status: "CANCELLED" as JobStatus };
      }
      return j;
    }));
  };

  const handleRetryJobManual = (jobId: string) => {
    // Clear countdown if any
    setCountdownJobs(prev => {
      const updated = { ...prev };
      delete updated[jobId];
      return updated;
    });

    setJobs(prev => prev.map(j => {
      if (j.id === jobId) {
        addSecurityLog("INFO", `Administrator manually triggered retry for Job "${j.fileName}" (${jobId}). Resetting attempts.`, jobId);
        return { ...j, status: "SCHEDULED" as JobStatus, retryCount: 0 };
      }
      return j;
    }));

    // Trigger worker execution
    setTimeout(() => {
      runWorkerForJob(jobId, simulationScenario);
    }, 500);
  };

  const handleDeleteJob = (id: string) => {
    setCountdownJobs(prev => {
      const updated = { ...prev };
      delete updated[id];
      return updated;
    });
    setJobs((prev) => prev.filter((j) => j.id !== id));
    addSecurityLog("INFO", `Deleted scheduled job: ${id}.`);
  };

  // Stat calculations
  const countPages = pages.length;
  const countScheduled = jobs.filter((j) => j.status === "SCHEDULED").length;
  const countPublishing = jobs.filter((j) => ["PREPARING", "UPLOADING_TO_META", "META_PROCESSING", "PUBLISHING"].includes(j.status)).length;
  const countPublished = jobs.filter((j) => j.status === "PUBLISHED").length;
  const countFailed = jobs.filter((j) => ["FAILED_RETRYABLE", "FAILED_PERMANENT", "FACEBOOK_RECONNECT_REQUIRED"].includes(j.status)).length;
  const hasExpiredTokens = pages.some((p) => p.tokenStatus === "Expired");
  const expiredPages = pages.filter((p) => p.tokenStatus === "Expired");

  return (
    <div className="flex flex-col flex-1 bg-zinc-950 text-zinc-100 font-sans min-h-screen">
      
      {/* 1. MOCK META MODE Pulsating Warning Banner */}
      <div className="w-full bg-amber-500 text-zinc-950 text-center py-2 px-4 font-bold flex items-center justify-center gap-2 text-xs md:text-sm tracking-wide shadow-md">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-zinc-900 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-zinc-950"></span>
        </span>
        <span>MOCK META MODE ACTIVE</span>
        <span className="font-normal border-l border-zinc-900 pl-2">
          Local Sandbox Simulator. No real Google Cloud uploads or Meta publishing calls are made.
        </span>
        <button
          onClick={handleResetDemo}
          className="ml-auto bg-zinc-950 text-amber-500 hover:bg-zinc-900 text-xs px-2.5 py-1 rounded font-semibold transition"
        >
          Reset Demo State
        </button>
      </div>

      {/* Code 190 Reconnection Required Alert */}
      {hasExpiredTokens && (
        <div className="w-full bg-rose-600 text-white text-center py-2.5 px-4 font-semibold text-sm flex items-center justify-center gap-3 animate-pulse">
          <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>Facebook API Code 190 Alert: Token expired for page(s): {expiredPages.map(p => p.name).join(", ")}. Reconnection required!</span>
          <button
            onClick={handleReconnectAll}
            className="bg-white text-rose-600 hover:bg-zinc-100 text-xs px-3 py-1 rounded-full font-bold transition shadow"
          >
            Quick Reconnect
          </button>
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="flex flex-1 flex-col md:flex-row">
        
        {/* Sidebar Panel */}
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
              Bulk Video Publisher {tempJobsQueue.length > 0 && `(${tempJobsQueue.length})`}
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
                  className="rounded bg-zinc-800 border-zinc-700 text-indigo-650 focus:ring-indigo-650 h-4 w-4"
                />
              </div>
              <div className="flex flex-col gap-1 text-xs">
                <span className="text-zinc-400 font-medium">Scenario</span>
                <select
                  value={simulationScenario}
                  onChange={(e) => setSimulationScenario(e.target.value as "success" | "network_failure" | "meta_processing_delay" | "rate_limit" | "invalid_format" | "revoked_token" | "missing_permission")}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-[11px] text-white focus:outline-none focus:border-indigo-650 font-sans"
                >
                  <option value="success">Success Scenario</option>
                  <option value="network_failure">Network Failure (Retryable)</option>
                  <option value="meta_processing_delay">Processing Delay (Retryable)</option>
                  <option value="rate_limit">Rate Limit (Retryable)</option>
                  <option value="invalid_format">Invalid Video Format (Perm)</option>
                  <option value="revoked_token">Revoked OAuth Token (Reconnect)</option>
                  <option value="missing_permission">Missing Page Permission (Perm)</option>
                </select>
              </div>
              <button
                onClick={handleSimulateQueueWorker}
                disabled={simulatingPublish}
                className="w-full bg-indigo-650 hover:bg-indigo-700 disabled:bg-zinc-850 disabled:text-zinc-500 font-semibold text-xs text-white py-2 px-3 rounded transition shadow-md shadow-indigo-600/10 flex items-center justify-center gap-1.5"
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

        {/* Content Panel */}
        <main className="flex-1 flex flex-col bg-zinc-950">
          
          {/* Header */}
          <header className="h-16 border-b border-zinc-900 px-8 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-white tracking-tight capitalize">
                {activeTab === "dashboard" ? "Dashboard Overview" : activeTab}
              </h2>
              <span className="text-xs bg-zinc-900 text-zinc-400 px-2 py-0.5 rounded font-mono border border-zinc-850/40">
                {kolkataOffsetStr}
              </span>
            </div>
            
            <div className="flex items-center gap-4 text-xs font-mono text-zinc-400">
              <span>Timezone: Asia/Kolkata</span>
              <span className="text-zinc-700">|</span>
              <span>Local System Time: {SYSTEM_TIME_STR}</span>
            </div>
          </header>

          {/* Main workspace container */}
          <div className="p-8 overflow-y-auto max-w-7xl w-full mx-auto flex-1">
            
            {/* STATS METRIC GRID */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition">
                <span className="text-xs font-mono text-zinc-500">Connected Pages</span>
                <h4 className="text-3xl font-extrabold text-white mt-1.5">{countPages}</h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition">
                <span className="text-xs font-mono text-zinc-500">Scheduled Jobs</span>
                <h4 className="text-3xl font-extrabold text-indigo-400 mt-1.5">{countScheduled}</h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition">
                <span className="text-xs font-mono text-zinc-500">Publishing Jobs</span>
                <h4 className="text-3xl font-extrabold text-amber-400 mt-1.5 flex items-center gap-2">
                  {countPublishing}
                  {countPublishing > 0 && <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping"></span>}
                </h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition">
                <span className="text-xs font-mono text-zinc-500">Published Jobs</span>
                <h4 className="text-3xl font-extrabold text-emerald-400 mt-1.5">{countPublished}</h4>
              </div>
              <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 hover:border-zinc-700 transition">
                <span className="text-xs font-mono text-zinc-500">Failed Jobs</span>
                <h4 className="text-3xl font-extrabold text-rose-500 mt-1.5">{countFailed}</h4>
              </div>
            </div>

            {/* TAB CONTAINER CONTENT */}
            
            {/* 1. OVERVIEW DASHBOARD TAB */}
            {activeTab === "dashboard" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                
                {/* Active Publishing Queue */}
                <div className="lg:col-span-2 flex flex-col gap-6">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-base font-bold text-white">Active Scheduled Jobs</h3>
                      <span className="text-xs text-zinc-500 font-mono">Times displayed in Asia/Kolkata</span>
                    </div>

                    {jobs.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-800 rounded-lg">
                        No videos loaded. Open the &quot;Bulk Video Publisher&quot; to schedule files.
                      </div>
                    ) : (
                      <div>
                        {/* Filters Toolbar */}
                        <div className="bg-zinc-950/50 border border-zinc-850 rounded-xl p-4 mb-5 flex flex-wrap gap-4 items-end text-xs">
                          <div className="flex-1 min-w-[180px]">
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1 font-bold">Search Filename/Title</label>
                            <input
                              type="text"
                              value={filterFilename}
                              onChange={(e) => setFilterFilename(e.target.value)}
                              placeholder="Search..."
                              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-1.5 px-3 text-xs text-white placeholder-zinc-700 focus:outline-none focus:border-indigo-650"
                            />
                          </div>
                          <div className="w-full sm:w-44">
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1 font-bold">Page</label>
                            <select
                              value={filterPageId}
                              onChange={(e) => setFilterPageId(e.target.value)}
                              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-1.5 px-3.5 text-xs text-white focus:outline-none"
                            >
                              <option value="all">All Pages</option>
                              {pages.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="w-full sm:w-44">
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1 font-bold">Status</label>
                            <select
                              value={filterStatus}
                              onChange={(e) => setFilterStatus(e.target.value)}
                              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-1.5 px-3.5 text-xs text-white focus:outline-none"
                            >
                              <option value="all">All Statuses</option>
                              <option value="DRAFT">Draft</option>
                              <option value="MEDIA_UPLOADED">Media Uploaded</option>
                              <option value="SCHEDULED">Scheduled</option>
                              <option value="PREPARING">Preparing</option>
                              <option value="UPLOADING_TO_META">Uploading to Meta</option>
                              <option value="META_PROCESSING">Meta Processing</option>
                              <option value="PUBLISHING">Publishing</option>
                              <option value="PUBLISHED">Published</option>
                              <option value="FAILED_RETRYABLE">Failed (Retryable)</option>
                              <option value="FAILED_PERMANENT">Failed (Permanent)</option>
                              <option value="CANCELLED">Cancelled</option>
                              <option value="FACEBOOK_RECONNECT_REQUIRED">Reconnect Required</option>
                            </select>
                          </div>
                          <div className="w-full sm:w-36">
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1 font-bold">Publish Date</label>
                            <input
                              type="date"
                              value={filterDate}
                              onChange={(e) => setFilterDate(e.target.value)}
                              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg py-1.5 px-3 text-xs text-white focus:outline-none"
                            />
                          </div>
                          {(filterPageId !== "all" || filterStatus !== "all" || filterFilename !== "" || filterDate !== "") && (
                            <button
                              onClick={() => {
                                setFilterPageId("all");
                                setFilterStatus("all");
                                setFilterFilename("");
                                setFilterDate("");
                              }}
                              className="bg-zinc-850 hover:bg-zinc-800 text-zinc-300 font-semibold py-1.5 px-3 rounded-lg text-xs transition border border-zinc-800"
                            >
                              Clear
                            </button>
                          )}
                        </div>

                        {filteredJobs.length === 0 ? (
                          <div className="text-center py-10 text-zinc-650 bg-zinc-950/20 border border-dashed border-zinc-850 rounded-xl text-xs">
                            No scheduled jobs match the active filters.
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm border-collapse">
                              <thead>
                                <tr className="border-b border-zinc-800 text-zinc-500 font-mono text-xs uppercase">
                                  <th className="pb-3 pr-4">File / Content Type</th>
                                  <th className="pb-3 px-4">Target Page</th>
                                  <th className="pb-3 px-4">Publish Date/Time (Kolkata)</th>
                                  <th className="pb-3 px-4">Status</th>
                                  <th className="pb-3 pl-4 text-right">Actions</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-zinc-800/50">
                                {filteredJobs.map((job) => {
                                  const targetPage = pages.find((p) => p.id === job.pageId);
                                  return (
                                    <tr key={job.id} className="hover:bg-zinc-850/30 transition">
                                      <td className="py-4 pr-4">
                                        <div className="font-medium text-white max-w-[180px] truncate">{job.fileName}</div>
                                        <div className="flex items-center gap-1.5 mt-0.5">
                                          <span className="text-xs text-zinc-500">{job.fileSize}</span>
                                          <span className="text-[10px] text-zinc-700">•</span>
                                          <span className="text-[10px] font-semibold text-indigo-400 font-mono tracking-wider">
                                            {job.contentType === "REEL" ? "Facebook Reel" : "Facebook Video"}
                                          </span>
                                        </div>
                                      </td>
                                      <td className="py-4 px-4 text-zinc-300 font-medium">
                                        {targetPage?.name || "Unassigned"}
                                      </td>
                                      <td className="py-4 px-4 font-mono text-xs">
                                        <div className="text-zinc-300">{formatDateTime(job.scheduledTimeKolkata)}</div>
                                        <div className="text-[10px] text-zinc-650 mt-0.5">UTC: {formatDateTime(job.scheduledTimeUTC)}Z</div>
                                      </td>
                                      <td className="py-4 px-4">
                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getStatusBadge(job.status)}`}>
                                          {getStatusLabel(job.status)}
                                        </span>
                                        {countdownJobs[job.id] !== undefined && (
                                          <div className="text-[10px] text-amber-500 font-mono mt-1 flex items-center gap-1">
                                            <span className="h-1 w-1 rounded-full bg-amber-500 animate-ping"></span>
                                            Retrying in {countdownJobs[job.id]}s...
                                          </div>
                                        )}
                                      </td>
                                      <td className="py-4 pl-4 text-right">
                                        {simulatingJobId === job.id ? (
                                          <div className="flex justify-end items-center gap-1.5 text-xs text-indigo-400 font-medium">
                                            <span className="animate-spin h-3.5 w-3.5 border-2 border-indigo-400 border-t-transparent rounded-full"></span>
                                            Running...
                                          </div>
                                        ) : (
                                          <div className="flex justify-end gap-1">
                                            {(job.status === "SCHEDULED" || job.status === "FAILED_RETRYABLE") && (
                                              <button
                                                onClick={() => handleCancelJob(job.id)}
                                                className="text-zinc-400 hover:text-amber-500 transition px-2 py-1 rounded hover:bg-amber-500/10 text-xs font-semibold"
                                              >
                                                Cancel
                                              </button>
                                            )}
                                            {(job.status === "FAILED_RETRYABLE" || job.status === "FAILED_PERMANENT" || job.status === "CANCELLED" || job.status === "FACEBOOK_RECONNECT_REQUIRED") && (
                                              <button
                                                onClick={() => handleRetryJobManual(job.id)}
                                                className="text-indigo-400 hover:text-indigo-300 transition px-2 py-1 rounded hover:bg-indigo-500/10 text-xs font-semibold"
                                              >
                                                Retry
                                              </button>
                                            )}
                                            <button
                                              onClick={() => setSelectedHistoryJob(job)}
                                              className="text-zinc-400 hover:text-white transition px-2 py-1 rounded hover:bg-zinc-800 text-xs font-semibold"
                                            >
                                              History
                                            </button>
                                            <button
                                              onClick={() => handleDeleteJob(job.id)}
                                              className="text-zinc-600 hover:text-rose-500 transition px-2 py-1 rounded hover:bg-rose-500/10 text-xs"
                                            >
                                              Delete
                                            </button>
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Job Diagnostics Inspector */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h3 className="text-base font-bold text-white mb-4">Job Diagnostics Inspector</h3>
                    <div className="space-y-4">
                      {jobs.map((job) => {
                        const isFinished = job.status === "PUBLISHED" || job.status === "FAILED_PERMANENT" || job.status === "FAILED_RETRYABLE" || job.status === "FACEBOOK_RECONNECT_REQUIRED" || job.status === "CANCELLED";
                        if (isFinished) {
                          const isFailed = job.status !== "PUBLISHED";
                          return (
                            <div key={job.id} className={`p-4 rounded-lg border text-xs font-mono ${
                              isFailed ? "bg-rose-950/20 border-rose-900/40" : "bg-emerald-950/20 border-emerald-900/40"
                            }`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className={`font-bold uppercase ${isFailed ? "text-rose-400" : "text-emerald-400"}`}>
                                  {getStatusLabel(job.status)} - ID: {job.id}
                                </span>
                                <span className="text-zinc-500">{job.fileName}</span>
                              </div>
                              {job.status === "PUBLISHED" && (
                                <p className="text-zinc-300">
                                  ✓ Meta Post ID Link: <a href="#" className="underline text-indigo-400" onClick={(e) => e.preventDefault()}>fb.com/{job.metaPostId}</a>
                                </p>
                              )}
                              {isFailed && (
                                <p className="text-rose-300 whitespace-pre-wrap">
                                  ✗ Error Reason: {job.errorLog}
                                </p>
                              )}
                            </div>
                          );
                        }
                        return null;
                      })}
                      {!jobs.some(j => ["PUBLISHED", "FAILED_PERMANENT", "FAILED_RETRYABLE", "FACEBOOK_RECONNECT_REQUIRED", "CANCELLED"].includes(j.status)) && (
                        <p className="text-xs text-zinc-500 text-center py-4 italic">
                          No finished or failed jobs to inspect. Run the &quot;Simulate Queue Worker&quot; script to generate execution results.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Worker Simulation Monitor */}
                <div className="flex flex-col gap-6">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col flex-1 h-full">
                    <h3 className="text-base font-bold text-white mb-2">Worker Simulation Log</h3>
                    <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
                      Watch background steps execute, including token decryption and mock video publishing chunk updates.
                    </p>
                    
                    <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-[11px] leading-relaxed text-zinc-300 flex-1 min-h-[300px] overflow-y-auto max-h-[450px]">
                      {simulationLog.length === 0 ? (
                        <div className="text-zinc-650 italic h-full flex items-center justify-center">
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

            {/* 2. BULK VIDEO PUBLISHER WORKSPACE (PHASE 2 CORE TAB) */}
            {activeTab === "publisher" && (
              <div className="space-y-8">
                
                {/* SETTINGS AND CSV PANEL ROW */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  
                  {/* File Upload Dropzone (Local Drag & Drop / File Picker) */}
                  <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col justify-between">
                    <div>
                      <h3 className="text-base font-bold text-white mb-2">Bulk Video Upload Workspace (Local Direct-to-App)</h3>
                      <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
                        Select multiple **MP4** or **MOV** files from your machine. Max configured file size limits are verified on selection.
                      </p>

                      <div
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        className="border-2 border-dashed border-zinc-800 hover:border-zinc-700/80 rounded-xl py-10 px-8 text-center bg-zinc-950/30 cursor-pointer relative group transition"
                      >
                        <input
                          type="file"
                          multiple
                          accept="video/mp4,video/quicktime"
                          onChange={triggerPickerChange}
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                        />
                        <svg className="h-10 w-10 text-zinc-650 group-hover:text-zinc-500 mx-auto mb-3 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        <span className="block text-sm text-zinc-300 font-semibold mb-1 group-hover:text-white transition">
                          Drag & Drop MP4/MOV Videos or Click to Browse
                        </span>
                        <span className="block text-xs text-zinc-500 font-mono">
                          Local upload engine validation. Limits applied dynamically.
                        </span>
                      </div>
                      
                      {fileUploadError && (
                        <div className="mt-3 text-xs text-rose-500 font-semibold bg-rose-950/15 border border-rose-900/35 rounded-lg p-2 flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
                          {fileUploadError}
                        </div>
                      )}
                    </div>

                    {/* Configuration settings block */}
                    <div className="mt-6 pt-5 border-t border-zinc-800/80 flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-xs font-semibold text-white">Configure Max File Size Boundary</h4>
                        <p className="text-[10px] text-zinc-500">Validation flag applies instantly to files exceeding this threshold.</p>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <input
                          type="number"
                          value={maxFileSizeMB}
                          onChange={(e) => setMaxFileSizeMB(Number(e.target.value))}
                          className="w-24 bg-zinc-950 border border-zinc-800 rounded-lg py-1.5 px-3 text-xs text-white text-center focus:outline-none focus:border-indigo-650 font-mono font-bold"
                          min={1}
                        />
                        <span className="text-xs font-mono text-zinc-400 font-bold">MB</span>
                      </div>
                    </div>
                  </div>

                  {/* CSV Metadata Importer */}
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col justify-between">
                    <div>
                      <h3 className="text-base font-bold text-white mb-2">CSV Metadata Importer</h3>
                      <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
                        Import a CSV metadata table matching video targets by filename. Shows row-level errors for broken formatting or invalid references.
                      </p>

                      <div className="flex flex-col gap-3">
                        <button
                          onClick={handleDownloadCsvTemplate}
                          className="w-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold py-2 px-3 border border-zinc-700 rounded-lg text-xs transition flex items-center justify-center gap-1.5"
                        >
                          Download CSV Template
                        </button>
                        
                        <div className="relative w-full bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded-lg p-2.5 text-center text-xs font-semibold text-white cursor-pointer transition">
                          Upload Metadata CSV File
                          <input
                            type="file"
                            accept=".csv"
                            onChange={handleUploadCsv}
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                          />
                        </div>
                      </div>
                    </div>

                    {/* CSV Parsing Status / Errors list */}
                    {(csvSuccessCount > 0 || csvErrors.length > 0) && (
                      <div className="mt-4 pt-4 border-t border-zinc-800/80 text-xs max-h-[160px] overflow-y-auto">
                        <div className="font-bold text-white mb-1.5 uppercase font-mono tracking-wider text-[10px]">Import Summary:</div>
                        {csvSuccessCount > 0 && (
                          <div className="text-emerald-400 font-medium mb-1 flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                            Successfully matched & updated {csvSuccessCount} videos.
                          </div>
                        )}
                        {csvErrors.map((err, idx) => (
                          <div key={idx} className="text-rose-400/90 leading-relaxed pl-3 border-l border-rose-900/60 mb-1 font-mono text-[10px]">
                            {err}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* BULK ACTIONS TOOLBAR */}
                {tempJobsQueue.length > 0 && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-400 mb-4 font-bold">Bulk Action Controller</h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 items-end text-xs">
                      {/* Bulk Page Selector */}
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Select Facebook Page</label>
                        <div className="flex gap-2">
                          <select
                            value={bulkPageId}
                            onChange={(e) => setBulkPageId(e.target.value)}
                            className="flex-1 bg-zinc-950 border border-zinc-850 rounded-lg py-2 px-2 text-xs text-white focus:outline-none"
                          >
                            {pages.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                          <button
                            onClick={handleApplyPageToAll}
                            className="bg-indigo-650 hover:bg-indigo-700 text-white font-bold px-3 rounded transition text-[10px]"
                          >
                            Apply
                          </button>
                        </div>
                      </div>

                      {/* Bulk Content Type Selector */}
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Select Content Type</label>
                        <div className="flex gap-2">
                          <select
                            value={bulkContentType}
                            onChange={(e) => setBulkContentType(e.target.value as "VIDEO" | "REEL")}
                            className="flex-1 bg-zinc-950 border border-zinc-850 rounded-lg py-2 px-2 text-xs text-white focus:outline-none"
                          >
                            <option value="VIDEO">Facebook Video</option>
                            <option value="REEL">Facebook Reel</option>
                          </select>
                          <button
                            onClick={handleApplyContentTypeToAll}
                            className="bg-indigo-650 hover:bg-indigo-700 text-white font-bold px-3 rounded transition text-[10px]"
                          >
                            Apply
                          </button>
                        </div>
                      </div>

                      {/* Bulk Caption Editor */}
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Configure English Caption</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={bulkCaption}
                            onChange={(e) => setBulkCaption(e.target.value)}
                            className="flex-1 bg-zinc-950 border border-zinc-850 rounded-lg py-2 px-2.5 text-xs text-white focus:outline-none placeholder-zinc-700"
                            placeholder="All caption text"
                          />
                          <button
                            onClick={handleApplyCaptionToAll}
                            className="bg-indigo-650 hover:bg-indigo-700 text-white font-bold px-3 rounded transition text-[10px]"
                          >
                            Apply
                          </button>
                        </div>
                      </div>

                      {/* Bulk Hashtags Editor */}
                      <div className="lg:col-span-2">
                        <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Configure Hashtags</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={bulkHashtags}
                            onChange={(e) => setBulkHashtags(e.target.value)}
                            className="flex-1 bg-zinc-950 border border-zinc-850 rounded-lg py-2 px-2.5 text-xs text-white focus:outline-none placeholder-zinc-700"
                            placeholder="e.g. #NewPost #Meta"
                          />
                          <button
                            onClick={handleAppendHashtagsToAll}
                            className="bg-zinc-800 hover:bg-zinc-750 text-white font-bold px-3.5 border border-zinc-700 rounded transition text-[10px]"
                          >
                            Append
                          </button>
                          <button
                            onClick={handleReplaceHashtagsToAll}
                            className="bg-indigo-650 hover:bg-indigo-700 text-white font-bold px-3.5 rounded transition text-[10px]"
                          >
                            Replace
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* BULK SCHEDULING MODE SWITCHER */}
                {tempJobsQueue.length > 0 && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4 border-b border-zinc-850 pb-3">
                      <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-400 font-bold">Scheduling Options</h3>
                      <div className="flex gap-3 text-xs">
                        <button
                          onClick={() => setSchedulingMode("individual")}
                          className={`px-3 py-1 rounded-full font-semibold transition ${
                            schedulingMode === "individual" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
                          }`}
                        >
                          Individual Settings
                        </button>
                        <button
                          onClick={() => setSchedulingMode("interval")}
                          className={`px-3 py-1 rounded-full font-semibold transition ${
                            schedulingMode === "interval" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
                          }`}
                        >
                          Fixed Intervals
                        </button>
                        <button
                          onClick={() => setSchedulingMode("slots")}
                          className={`px-3 py-1 rounded-full font-semibold transition ${
                            schedulingMode === "slots" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
                          }`}
                        >
                          Daily Time Slots
                        </button>
                      </div>
                    </div>

                    {/* Mode Panels */}
                    {schedulingMode === "individual" && (
                      <p className="text-xs text-zinc-500 leading-relaxed">
                        Configure dates and times individually on each video card below. Set a target date/time to prompt job promotion to scheduling queue.
                      </p>
                    )}

                    {schedulingMode === "interval" && (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                        <div>
                          <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Start Date / Time (Kolkata)</label>
                          <input
                            type="datetime-local"
                            value={intervalStartKolkata}
                            onChange={(e) => setIntervalStartKolkata(e.target.value)}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-3.5 text-xs text-white focus:outline-none focus:border-indigo-650"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Post Spacing Frequency</label>
                          <select
                            value={intervalHours}
                            onChange={(e) => setIntervalHours(parseInt(e.target.value))}
                            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-3.5 text-xs text-white focus:outline-none focus:border-indigo-650"
                          >
                            <option value={1}>Every 1 hour</option>
                            <option value={2}>Every 2 hours</option>
                            <option value={4}>Every 4 hours</option>
                            <option value={6}>Every 6 hours</option>
                            <option value={12}>Every 12 hours</option>
                            <option value={24}>Every 24 hours</option>
                          </select>
                        </div>
                        <button
                          onClick={handleApplySchedulingMode}
                          className="bg-indigo-650 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-lg text-xs transition"
                        >
                          Apply Sequential Intervals
                        </button>
                      </div>
                    )}

                    {schedulingMode === "slots" && (
                      <div className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Daily Start Date</label>
                            <input
                              type="date"
                              value={dailySlotsStartDate}
                              onChange={(e) => setDailySlotsStartDate(e.target.value)}
                              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-3.5 text-xs text-white focus:outline-none focus:border-indigo-650"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Configure Time Slot (24h HH:MM)</label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={newSlotInput}
                                onChange={(e) => setNewSlotInput(e.target.value)}
                                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg py-2.5 px-3.5 text-xs text-white placeholder-zinc-700"
                                placeholder="e.g. 14:30"
                              />
                              <button
                                onClick={handleAddSlot}
                                className="bg-zinc-800 hover:bg-zinc-750 text-white font-bold px-3 border border-zinc-700 rounded-lg transition"
                              >
                                Add
                              </button>
                            </div>
                          </div>
                          <button
                            onClick={handleApplySchedulingMode}
                            className="bg-indigo-650 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-lg text-xs transition"
                          >
                            Distribute over Daily Slots
                          </button>
                        </div>

                        {/* List of active daily time slots */}
                        <div className="flex flex-wrap gap-2.5 text-xs">
                          {dailyTimeSlots.map((slot, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-zinc-950 border border-zinc-850 font-mono text-xs font-bold text-zinc-200"
                            >
                              {slot}
                              <button
                                onClick={() => handleRemoveSlot(idx)}
                                className="text-zinc-650 hover:text-rose-500 font-bold ml-1.5"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          {dailyTimeSlots.length === 0 && (
                            <span className="text-xs text-zinc-600 italic">No daily time slots configured yet.</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* EDIT QUEUED BULK CARDS LIST */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                  <div className="flex items-center justify-between mb-6 border-b border-zinc-800 pb-4">
                    <div>
                      <h3 className="text-base font-bold text-white mb-0.5">Publisher Upload Cards</h3>
                      <p className="text-xs text-zinc-500">Configure parameters for local videos awaiting scheduling confirmation.</p>
                    </div>
                    {tempJobsQueue.length > 0 && (
                      <button
                        onClick={handleSaveTrigger}
                        className="bg-emerald-650 hover:bg-emerald-600 text-white font-bold text-xs py-2 px-4 rounded-lg transition shadow-md shadow-emerald-600/10"
                      >
                        Confirm Scheduled Queue
                      </button>
                    )}
                  </div>

                  <div className="space-y-6">
                    {tempJobsQueue.map((job) => {
                      const errors = getJobValidationErrors(job, tempJobsQueue);
                      return (
                        <div
                          key={job.id}
                          className={`bg-zinc-950 border rounded-xl p-6 relative transition ${
                            errors.length > 0 ? "border-rose-900/60" : "border-zinc-850"
                          }`}
                        >
                          <button
                            onClick={() => handleDeleteDraft(job.id)}
                            className="absolute top-4 right-4 text-xs text-rose-500 hover:underline transition"
                          >
                            Remove Video
                          </button>

                          {/* Validation Badges */}
                          {errors.length > 0 && (
                            <div className="mb-4 space-y-1.5">
                              {errors.map((err, idx) => (
                                <div key={idx} className="text-[10px] text-rose-400 font-semibold font-mono bg-rose-950/15 border border-rose-900/30 px-2 py-1 rounded">
                                  ⚠ Validation Error: {err}
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="flex flex-col lg:flex-row gap-6">
                            
                            {/* File Preview & Thumbnail Capture Column */}
                            <div className="w-full lg:w-72 flex-shrink-0 flex flex-col gap-4">
                              
                              {/* Native video preview */}
                              {job.localVideoUrl ? (
                                <div className="aspect-video bg-black rounded-lg overflow-hidden border border-zinc-850 relative flex items-center justify-center">
                                  <video
                                    src={job.localVideoUrl}
                                    className="h-full w-full object-contain"
                                    controls
                                  />
                                </div>
                              ) : (
                                <div className="aspect-video bg-zinc-900 rounded-lg flex items-center justify-center border border-zinc-850 text-zinc-600 text-xs">
                                  Video Preview Unavailable
                                </div>
                              )}

                              <div className="text-xs space-y-1.5 text-zinc-400 font-mono">
                                <div className="truncate max-w-[280px]">Original Name: <span className="text-zinc-200">{job.fileName}</span></div>
                                <div>Size: <span className="text-zinc-200">{job.fileSize}</span></div>
                                <div>Duration: <span className="text-zinc-200">{job.durationSeconds ? `${job.durationSeconds}s` : "Scanning..."}</span></div>
                                <div>Language: <span className="text-indigo-400 font-semibold">English (Fixed)</span></div>
                              </div>

                              {/* Thumbnail Settings */}
                              <div className="border-t border-zinc-850/80 pt-3.5 space-y-2 text-xs">
                                <label className="block font-mono text-zinc-500 uppercase tracking-wider text-[10px]">Assign Thumbnail</label>
                                
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => handleUpdateTempJobField(job.id, "thumbnailMode", "auto")}
                                    className={`flex-1 py-1 border rounded text-[10px] font-bold transition ${
                                      job.thumbnailMode === "auto" ? "bg-zinc-800 border-zinc-700 text-white" : "border-zinc-850 text-zinc-500"
                                    }`}
                                  >
                                    Auto Meta
                                  </button>
                                  <button
                                    onClick={() => handleOpenFrameCaptureModal(job)}
                                    className={`flex-1 py-1 border rounded text-[10px] font-bold transition ${
                                      job.thumbnailMode === "captured" ? "bg-zinc-850 border-zinc-700 text-white" : "border-zinc-850 text-zinc-500"
                                    }`}
                                  >
                                    Capture Frame
                                  </button>
                                  <div className="relative flex-1">
                                    <button
                                      className={`w-full py-1 border rounded text-[10px] font-bold transition ${
                                        job.thumbnailMode === "custom" ? "bg-zinc-850 border-zinc-700 text-white" : "border-zinc-850 text-zinc-500"
                                      }`}
                                    >
                                      Custom JPG
                                    </button>
                                    <input
                                      type="file"
                                      accept="image/jpeg,image/png"
                                      onChange={(e) => {
                                        if (e.target.files?.[0]) {
                                          const localUrl = URL.createObjectURL(e.target.files[0]);
                                          handleUpdateTempJobField(job.id, "customThumbnailUrl", localUrl);
                                          handleUpdateTempJobField(job.id, "thumbnailMode", "custom");
                                          addSecurityLog("INFO", `Uploaded custom image ${e.target.files[0].name} for local job thumbnail.`);
                                        }
                                      }}
                                      className="absolute inset-0 opacity-0 cursor-pointer"
                                    />
                                  </div>
                                </div>

                                {/* Thumbnail preview slot */}
                                {job.thumbnailMode === "captured" && job.capturedThumbnailUrl && (
                                  <div className="mt-2 text-center">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={job.capturedThumbnailUrl}
                                      alt="Captured Frame Preview"
                                      className="aspect-video w-full rounded border border-zinc-800 object-cover"
                                    />
                                    <span className="text-[9px] text-zinc-650 mt-1 block">Local video frame capture</span>
                                  </div>
                                )}
                                {job.thumbnailMode === "custom" && job.customThumbnailUrl && (
                                  <div className="mt-2 text-center">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={job.customThumbnailUrl}
                                      alt="Custom Thumbnail Preview"
                                      className="aspect-video w-full rounded border border-zinc-800 object-cover"
                                    />
                                    <span className="text-[9px] text-zinc-650 mt-1 block">Custom JPG preview</span>
                                  </div>
                                )}
                                {job.thumbnailMode === "auto" && (
                                  <div className="text-[9px] text-zinc-600 bg-zinc-900 border border-zinc-850 rounded p-2 text-center mt-2 italic">
                                    Facebook will automatically generate the thumbnail.
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Editable Fields Column */}
                            <div className="flex-1 space-y-4 text-xs">
                              
                              {/* English Title input */}
                              <div>
                                <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">English Title</label>
                                <input
                                  type="text"
                                  value={job.englishTitle}
                                  onChange={(e) => handleUpdateTempJobField(job.id, "englishTitle", e.target.value)}
                                  className="w-full bg-zinc-900 border border-zinc-850 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-650 transition placeholder-zinc-700"
                                  placeholder="Video title in English"
                                />
                              </div>

                              {/* English Caption text area */}
                              <div>
                                <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">English Caption</label>
                                <textarea
                                  value={job.englishCaption}
                                  rows={2}
                                  onChange={(e) => handleUpdateTempJobField(job.id, "englishCaption", e.target.value)}
                                  className="w-full bg-zinc-900 border border-zinc-850 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-650 transition placeholder-zinc-700"
                                  placeholder="Explain your video..."
                                />
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {/* Hashtags */}
                                <div>
                                  <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">Hashtags</label>
                                  <input
                                    type="text"
                                    value={job.hashtags}
                                    onChange={(e) => handleUpdateTempJobField(job.id, "hashtags", e.target.value)}
                                    className="w-full bg-zinc-900 border border-zinc-850 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-650 transition placeholder-zinc-700"
                                    placeholder="#Vlog #Reels"
                                  />
                                </div>

                                {/* Destination Facebook Page selector */}
                                <div>
                                  <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">Target Page</label>
                                  <select
                                    value={job.pageId}
                                    onChange={(e) => handleUpdateTempJobField(job.id, "pageId", e.target.value)}
                                    className="w-full bg-zinc-900 border border-zinc-850 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-650 transition"
                                  >
                                    {pages.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        {p.name} {p.tokenStatus === "Expired" ? "(Expired!)" : ""}
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                {/* Content type selector */}
                                <div>
                                  <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">Content Type</label>
                                  <select
                                    value={job.contentType}
                                    onChange={(e) => handleUpdateTempJobField(job.id, "contentType", e.target.value as "VIDEO" | "REEL")}
                                    className="w-full bg-zinc-900 border border-zinc-850 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-650 transition"
                                  >
                                    <option value="VIDEO">Facebook Video</option>
                                    <option value="REEL">Facebook Reel</option>
                                  </select>
                                </div>
                              </div>

                              {/* Scheduled Time picker */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                  <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">
                                    Publish Time (Local Kolkata)
                                  </label>
                                  <input
                                    type="datetime-local"
                                    value={job.scheduledTimeKolkata}
                                    onChange={(e) => handleUpdateTempJobField(job.id, "scheduledTimeKolkata", e.target.value)}
                                    className="w-full bg-zinc-900 border border-zinc-850 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-indigo-650 transition"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">
                                    Internal UTC ISO (Prisma Storage)
                                  </label>
                                  <div className="w-full bg-zinc-900 border border-zinc-900 rounded-lg py-2.5 px-3 font-mono text-zinc-500 break-all select-all">
                                    {job.scheduledTimeUTC ? `${formatDateTime(job.scheduledTimeUTC)}Z` : "Awaiting local selection..."}
                                  </div>
                                </div>
                              </div>

                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {tempJobsQueue.length === 0 && (
                      <div className="text-center py-10 text-zinc-650 bg-zinc-950/20 border border-dashed border-zinc-800 rounded-xl">
                        Awaiting video uploads to display publishing configuration forms.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 3. SYNCED PAGES TAB */}
            {activeTab === "pages" && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
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
                      className="bg-indigo-650 hover:bg-indigo-700 disabled:bg-zinc-850 disabled:text-zinc-500 font-semibold text-xs text-white py-2.5 px-4 rounded-lg transition flex items-center justify-center gap-1.5"
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

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {pages.map((page) => (
                    <div
                      key={page.id}
                      className={`bg-zinc-950 border rounded-xl p-5 hover:border-zinc-750 transition flex flex-col justify-between min-h-[160px] ${
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
              </div>
            )}

            {/* 4. SECURITY LOGS TAB */}
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
                    <p className="text-zinc-650 italic text-center py-10">No logs generated.</p>
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

      {/* ==========================================
          MODALS & WIDGETS
          ========================================== */}

      {/* Local Frame Capture Modal Drawer */}
      {activeFrameCaptureJobId && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h4 className="font-bold text-white text-sm uppercase font-mono tracking-wide">Capture Thumbnail Frame</h4>
              <button
                onClick={() => setActiveFrameCaptureJobId(null)}
                className="text-zinc-400 hover:text-white font-bold text-lg"
              >
                ×
              </button>
            </div>

            <div className="aspect-video bg-black rounded-lg overflow-hidden border border-zinc-800 relative flex items-center justify-center">
              {/* Capture video target element */}
              <video
                ref={videoCaptureRef}
                src={frameCaptureUrl}
                className="h-full w-full object-contain"
                crossOrigin="anonymous"
              />
            </div>

            {/* Slider control */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs font-mono text-zinc-400">
                <span>Capture Position: {frameCaptureTime.toFixed(1)}s</span>
                <span>Total Length: {frameCaptureDuration}s</span>
              </div>
              <input
                type="range"
                min={0}
                max={frameCaptureDuration}
                step={0.1}
                value={frameCaptureTime}
                onChange={(e) => setFrameCaptureTime(Number(e.target.value))}
                className="w-full accent-indigo-650 h-1.5 bg-zinc-850 rounded-lg cursor-pointer"
              />
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-zinc-800 text-xs">
              <button
                onClick={() => setActiveFrameCaptureJobId(null)}
                className="px-4 py-2 border border-zinc-800 text-zinc-300 font-semibold rounded-lg hover:bg-zinc-800 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleCaptureFrameAction}
                className="px-4 py-2 bg-indigo-650 hover:bg-indigo-700 text-white font-semibold rounded-lg transition"
              >
                Confirm & Snapshot Frame
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal before Scheduling saves to State */}
      {isConfirmationOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h4 className="font-bold text-white text-base uppercase font-mono tracking-wide">Confirm Scheduling Batch</h4>
              <button
                onClick={() => setIsConfirmationOpen(false)}
                className="text-zinc-400 hover:text-white font-bold text-lg"
              >
                ×
              </button>
            </div>

            <p className="text-xs text-zinc-400 leading-relaxed">
              Verify the local schedule conversions below. Confirming will create the corresponding scheduled tasks.
            </p>

            {/* Queue Summary list table */}
            <div className="border border-zinc-800 rounded-xl overflow-hidden text-xs">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-950 border-b border-zinc-800 text-zinc-500 font-mono text-[10px] uppercase">
                    <th className="p-3.5">Filename</th>
                    <th className="p-3.5">Content Type</th>
                    <th className="p-3.5">Target Page</th>
                    <th className="p-3.5">Local Time (Kolkata)</th>
                    <th className="p-3.5">UTC Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 bg-zinc-950/20 font-mono">
                  {tempJobsQueue.map((job) => {
                    const targetPage = pages.find((p) => p.id === job.pageId);
                    return (
                      <tr key={job.id} className="hover:bg-zinc-900/40">
                        <td className="p-3.5 text-white font-sans font-medium truncate max-w-[150px]">{job.fileName}</td>
                        <td className="p-3.5 font-bold text-indigo-400 text-[10px]">{job.contentType === "REEL" ? "Facebook Reel" : "Facebook Video"}</td>
                        <td className="p-3.5 text-zinc-300 font-sans font-medium">{targetPage?.name || "Unassigned"}</td>
                        <td className="p-3.5 text-zinc-300">{formatDateTime(job.scheduledTimeKolkata)}</td>
                        <td className="p-3.5 text-zinc-500 break-all">{formatDateTime(job.scheduledTimeUTC)}Z</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-zinc-800 text-xs">
              <button
                onClick={() => setIsConfirmationOpen(false)}
                className="px-4 py-2 border border-zinc-800 text-zinc-300 font-semibold rounded-lg hover:bg-zinc-800 transition"
              >
                Go Back (Edit Details)
              </button>
              <button
                onClick={handleConfirmSave}
                className="px-5 py-2.5 bg-emerald-650 hover:bg-emerald-600 text-white font-semibold rounded-lg transition shadow-md shadow-emerald-650/15"
              >
                Confirm Batch Scheduling
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History & Audit Logs Modal */}
      {selectedHistoryJob && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden shadow-2xl p-6 flex flex-col gap-4">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h4 className="font-bold text-white text-base">Job History & Logs</h4>
                <p className="text-xs text-zinc-500 font-mono mt-0.5">{selectedHistoryJob.fileName} ({selectedHistoryJob.id})</p>
              </div>
              <button
                onClick={() => setSelectedHistoryJob(null)}
                className="text-zinc-400 hover:text-white font-bold text-xl transition"
              >
                &times;
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-zinc-800 text-xs">
              <button
                onClick={() => setHistoryModalTab("attempts")}
                className={`px-4 py-2 border-b-2 font-bold transition ${
                  historyModalTab === "attempts"
                    ? "border-indigo-500 text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Publish Attempts
              </button>
              <button
                onClick={() => setHistoryModalTab("audit")}
                className={`px-4 py-2 border-b-2 font-bold transition ${
                  historyModalTab === "audit"
                    ? "border-indigo-500 text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Audit Transitions Log
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto min-h-[250px] max-h-[50vh] text-xs">
              {historyModalTab === "attempts" ? (
                <div className="space-y-4">
                  {(!selectedHistoryJob.attempts || selectedHistoryJob.attempts.length === 0) ? (
                    <div className="text-center py-10 text-zinc-500 italic bg-zinc-950/20 border border-dashed border-zinc-800 rounded-lg">
                      No publish attempts recorded yet. Process this job in the worker to see results.
                    </div>
                  ) : (
                    <div className="border border-zinc-800 rounded-xl overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-zinc-950 border-b border-zinc-800 text-zinc-500 font-mono text-[10px] uppercase">
                            <th className="p-3">Attempt</th>
                            <th className="p-3">Start (UTC)</th>
                            <th className="p-3">Completed (UTC)</th>
                            <th className="p-3">Resulting State</th>
                            <th className="p-3">Error Code</th>
                            <th className="p-3">Explanation</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800 bg-zinc-950/10 font-mono text-[11px]">
                          {selectedHistoryJob.attempts.map((attempt, index) => (
                            <tr key={index} className="hover:bg-zinc-900/40">
                              <td className="p-3 text-white font-bold">#{attempt.attemptNumber}</td>
                              <td className="p-3 text-zinc-400">{formatDateTime(attempt.startTime)}</td>
                              <td className="p-3 text-zinc-400">{formatDateTime(attempt.completionTime)}</td>
                              <td className="p-3">
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${getStatusBadge(attempt.resultingState)}`}>
                                  {getStatusLabel(attempt.resultingState)}
                                </span>
                              </td>
                              <td className="p-3 text-rose-400 font-bold">{attempt.errorCode || "-"}</td>
                              <td className="p-3 text-zinc-300 font-sans">{attempt.explanation}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-[11px] leading-relaxed text-zinc-300 space-y-2">
                  {(() => {
                    const jobLogs = securityLogs.filter(log => log.jobId === selectedHistoryJob.id);
                    if (jobLogs.length === 0) {
                      return <p className="text-zinc-650 italic text-center py-6">No audit records found for this specific job.</p>;
                    }
                    return jobLogs.map((log, idx) => (
                      <div key={idx} className="flex items-start gap-4">
                        <span className="text-zinc-600 flex-shrink-0">[{formatDateTime(log.timestampUTC)}]</span>
                        <span className={`font-bold flex-shrink-0 ${
                          log.level === "ERROR" ? "text-rose-500" : log.level === "WARN" ? "text-amber-500" : "text-indigo-400"
                        }`}>
                          {log.level}
                        </span>
                        <span className="text-zinc-300 leading-relaxed">{log.message}</span>
                      </div>
                    ));
                  })()}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end pt-3 border-t border-zinc-800">
              <button
                onClick={() => setSelectedHistoryJob(null)}
                className="px-4 py-2 bg-zinc-800 text-white font-semibold rounded-lg hover:bg-zinc-700 transition"
              >
                Close Window
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
