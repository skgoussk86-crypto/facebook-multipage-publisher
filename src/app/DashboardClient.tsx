"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import VideoUploader from "../components/uploads/video-uploader";
import { UploadQueueController, QueueItem } from "../lib/uploads/upload-queue-controller";
import {
  SUPPORTED_IMAGE_ACCEPT,
  SUPPORTED_VIDEO_ACCEPT,
  getSupportedMediaDescriptor,
  type UploadContentType,
} from "../lib/uploads/media-file-types";
import {
  containsUnsafeControlCharacters,
  countUnicodeCharacters,
  isSingleLineMetadataText,
  normalizeDashboardJobs,
} from "../lib/validation";
import {
  buildGeminiAnalysisUrl,
  getGeminiAnalysisErrorMessage,
} from "../lib/gemini/gemini-dashboard-analysis";
import { parseAnalysisStream, validateStreamResponseContentType } from "../lib/ai/ai-analysis-stream-client";
import {
  buildThumbnailGenerationUrl,
  getThumbnailGenerationErrorMessage,
  parseThumbnailGenerationResponse,
  type DashboardThumbnailSource,
} from "../lib/thumbnails/thumbnail-dashboard-client";
import {
  shouldApplyOllamaThumbnail,
} from "../lib/thumbnails/thumbnail-selection";
import {
  buildBulkMetadataPreview,
  buildLineSeparatedMetadataRows,
  parseBulkMetadataCsv,
  type BulkMetadataMatchMode,
  type BulkMetadataPreview,
  type BulkMetadataRow,
} from "../lib/metadata/bulk-metadata-assignment";
import {
  buildRandomSchedulePreview,
  buildRandomScheduleQueueSignature,
  getCurrentKolkataDateString,
  type RandomSchedulePreview,
  type RandomTimeWindow,
} from "../lib/scheduling/random-time-windows";

// Types
interface FacebookPage {
  id: string;
  name: string;
  category: string;
  pictureUrl: string;
  tokenStatus: "Valid" | "Expired";
  connectedAt: string;
  accountId?: string;
  accountName?: string;
}

interface FacebookAccountUI {
  id: string;
  facebookUserId: string;
  name: string;
  tokenExpiresAt: string;
  connectionState: 'Connected' | 'Token Expiring' | 'Reconnection Required' | 'Permission Missing';
  pages: FacebookPage[];
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
  | "FACEBOOK_RECONNECT_REQUIRED"
  | "PENDING"
  | "PROCESSING"
  | "FAILED";

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
  pageName?: string;
  contentType: UploadContentType;
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
  localMediaUrl?: string; // local object URL of the selected video or image
  localVideoUrl?: string; // legacy local object URL retained for restored video cards
  gcsVideoUri?: string; // persistent simulated GCS URI
  attempts?: PublishAttempt[];
  providerReference?: string;
  providerProcessingId?: string;
  file?: File;
  assetId?: string;
  uploadValidated?: boolean;
  geminiAnalysisStatus?:
    | "idle"
    | "queued"
    | "analyzing"
    | "complete"
    | "error"
    | "cancelled";
  geminiAnalysisError?: string;
  geminiThumbnailTimestampSeconds?: number;
  geminiThumbnailReason?: string;
  geminiAnalyzedAt?: string;
  thumbnailAssetId?: string;
  thumbnailGenerationStatus?:
    | "idle"
    | "generating"
    | "complete"
    | "error";
  thumbnailGenerationError?: string;
  thumbnailTimestampSeconds?: number;
  thumbnailSource?: DashboardThumbnailSource;
}

interface SecurityLog {
  timestampUTC: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  jobId?: string;
}

interface BulkMetadataUndoEntry {
  jobId: string;
  englishTitle: string;
  englishCaption: string;
}

interface RandomScheduleUndoEntry {
  jobId: string;
  scheduledTimeKolkata: string;
  scheduledTimeUTC: string;
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

type MockScenario =
  | 'SUCCESS'
  | 'TEMPORARY_NETWORK_FAILURE'
  | 'META_PROCESSING_DELAY'
  | 'META_RATE_LIMIT'
  | 'INVALID_MEDIA_FORMAT'
  | 'REVOKED_FACEBOOK_TOKEN'
  | 'MISSING_FACEBOOK_PERMISSION'
  | 'PERMANENT_PUBLISHING_FAILURE';

const normalizeClientScenario = (val: string | null | undefined): MockScenario => {
  if (!val) return 'SUCCESS';
  const clean = val.trim().toUpperCase();
  const validScenarios: MockScenario[] = [
    'SUCCESS',
    'TEMPORARY_NETWORK_FAILURE',
    'META_PROCESSING_DELAY',
    'META_RATE_LIMIT',
    'INVALID_MEDIA_FORMAT',
    'REVOKED_FACEBOOK_TOKEN',
    'MISSING_FACEBOOK_PERMISSION',
    'PERMANENT_PUBLISHING_FAILURE'
  ];
  if (validScenarios.includes(clean as MockScenario)) {
    return clean as MockScenario;
  }
  switch (val.trim().toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'network_failure':
    case 'temporary_network_failure':
      return 'TEMPORARY_NETWORK_FAILURE';
    case 'meta_processing_delay':
      return 'META_PROCESSING_DELAY';
    case 'rate_limit':
    case 'meta_rate_limit':
      return 'META_RATE_LIMIT';
    case 'invalid_format':
    case 'invalid_media_format':
      return 'INVALID_MEDIA_FORMAT';
    case 'revoked_token':
    case 'revoked_facebook_token':
      return 'REVOKED_FACEBOOK_TOKEN';
    case 'missing_permission':
    case 'missing_facebook_permission':
      return 'MISSING_FACEBOOK_PERMISSION';
    case 'permanent_publishing_failure':
      return 'PERMANENT_PUBLISHING_FAILURE';
    default:
      return 'SUCCESS';
  }
};


export default function DashboardClient({ currentUser }: { currentUser: { id: string, email: string, name: string, role: string } }) {
  // Navigation State
  const [activeTab, setActiveTab] = useState<"dashboard" | "publisher" | "pages" | "logs">("dashboard");
  const [systemTimeStr, setSystemTimeStr] = useState("2026-07-12 19:42:24");

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/admin/login", { method: "DELETE" });
      if (res.ok) {
        window.location.href = "/login";
      }
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  // Core Persistent States
  const [accounts, setAccounts] = useState<FacebookAccountUI[]>([]);
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [publicAppUrl, setPublicAppUrl] = useState("");
  const [facebookAppId, setFacebookAppId] = useState("");
  const [jobs, setJobs] = useState<VideoJob[]>([]);
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
  const [simulationScenario, setSimulationScenario] = useState<MockScenario>("SUCCESS");
  const [countdownJobs, setCountdownJobs] = useState<Record<string, number>>({});
  const [selectedHistoryJob, setSelectedHistoryJob] = useState<VideoJob | null>(null);
  const [historyModalTab, setHistoryModalTab] = useState<"attempts" | "audit">("attempts");
  const [simulatingJobId, setSimulatingJobId] = useState<string | null>(null);
  const [isSavingJobs, setIsSavingJobs] = useState(false);

  // Filter States
  const [filterPageId, setFilterPageId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterFilename, setFilterFilename] = useState<string>("");
  const [filterDate, setFilterDate] = useState<string>("");

  const getStatusBadge = (status: JobStatus) => {
    switch (status) {
      case "DRAFT":
        return "bg-zinc-100 text-zinc-700 border border-zinc-200";
      case "MEDIA_UPLOADED":
        return "bg-blue-50 text-blue-800 border border-blue-200";
      case "SCHEDULED":
      case "PENDING":
        return "bg-indigo-50 text-indigo-800 border border-indigo-200";
      case "PREPARING":
      case "PROCESSING":
        return "bg-purple-50 text-purple-800 border border-purple-200 animate-pulse";
      case "UPLOADING_TO_META":
        return "bg-cyan-50 text-cyan-800 border border-cyan-200 animate-pulse";
      case "META_PROCESSING":
        return "bg-amber-50 text-amber-800 border border-amber-200 animate-pulse";
      case "PUBLISHING":
        return "bg-amber-50 text-amber-800 border border-amber-200 animate-pulse";
      case "PUBLISHED":
        return "bg-emerald-50 text-emerald-800 border border-emerald-200";
      case "FAILED_RETRYABLE":
        return "bg-amber-50 text-amber-800 border border-amber-200";
      case "FAILED_PERMANENT":
      case "FAILED":
        return "bg-rose-50 text-rose-800 border border-rose-200";
      case "CANCELLED":
        return "bg-zinc-100 text-zinc-500 border border-zinc-200";
      case "FACEBOOK_RECONNECT_REQUIRED":
        return "bg-rose-50 text-rose-800 border border-rose-200 animate-pulse";
      default:
        return "bg-zinc-100 text-zinc-500 border border-zinc-200";
    }
  };

  const getStatusLabel = (status: JobStatus) => {
    switch (status) {
      case "DRAFT": return "Draft";
      case "MEDIA_UPLOADED": return "Media Uploaded";
      case "SCHEDULED": return "Scheduled";
      case "PENDING": return "Pending";
      case "PREPARING": return "Preparing";
      case "PROCESSING": return "Processing";
      case "UPLOADING_TO_META": return "Uploading to Meta";
      case "META_PROCESSING": return "Meta Processing";
      case "PUBLISHING": return "Publishing";
      case "PUBLISHED": return "Published";
      case "FAILED_RETRYABLE": return "Failed (Retryable)";
      case "FAILED_PERMANENT": return "Failed (Permanent)";
      case "FAILED": return "Failed";
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
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [isBulkGeminiAnalysisRunning, setIsBulkGeminiAnalysisRunning] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<{
    active: number;
    completed: number;
    failed: number;
    total: number;
    cancelled: number;
  } | null>(null);
  const [activeBatchAssetIds, setActiveBatchAssetIds] = useState<string[]>([]);
  const batchAbortControllerRef = useRef<AbortController | null>(null);
  const queueControllerRef = useRef<UploadQueueController | null>(null);
  const activeAnalysisAborts = useRef<Record<string, AbortController>>({});

  useEffect(() => {
    const aborts = activeAnalysisAborts.current;
    return () => {
      Object.values(aborts).forEach((controller) => {
        controller.abort();
      });
      batchAbortControllerRef.current?.abort();
    };
  }, []);

  const pagesRef = useRef(pages);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    const controller = new UploadQueueController({
      maxConcurrency: 2,
      onChange: (items) => {
        setQueueItems(items);
        setTempJobsQueue((prev) => {
          return items.map((item) => {
            const existing = prev.find((j) => j.id === item.id);
            const sizeMB = (item.size / (1024 * 1024)).toFixed(1) + " MB";
            return {
              id: item.id,
              fileName: item.filename,
              fileSize: sizeMB,
              fileSizeBytes: item.size,
              durationSeconds: item.durationSeconds ?? existing?.durationSeconds,
              uploadProgress: item.progressPercent,
              pageId: item.pageId || existing?.pageId || (pagesRef.current.find((p) => p.id === item.pageId)?.id || pagesRef.current[0]?.id || ""),
              contentType: item.contentType || existing?.contentType || "VIDEO",
              englishTitle: item.englishTitle ?? existing?.englishTitle ?? item.filename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " "),
              englishCaption: item.englishCaption ?? existing?.englishCaption ?? "",
              hashtags: item.hashtags || existing?.hashtags || "",
              scheduledTimeKolkata: item.scheduledTimeKolkata || existing?.scheduledTimeKolkata || "",
              scheduledTimeUTC: item.scheduledTimeUTC || existing?.scheduledTimeUTC || "",
              status: "DRAFT",
              retryCount: 0,
              thumbnailMode: item.thumbnailMode || existing?.thumbnailMode || "auto",
              customThumbnailUrl: item.customThumbnailUrl || existing?.customThumbnailUrl,
              capturedThumbnailUrl: item.capturedThumbnailUrl || existing?.capturedThumbnailUrl,
              localMediaUrl: item.localMediaUrl || item.localVideoUrl || existing?.localMediaUrl || existing?.localVideoUrl,
              localVideoUrl: item.localVideoUrl || (item.contentType !== "PHOTO" ? item.localMediaUrl : undefined) || existing?.localVideoUrl,
              assetId: item.assetId,
              uploadValidated: item.status === 'VALIDATED',
              geminiAnalysisStatus:
                item.geminiAnalysisStatus ||
                existing?.geminiAnalysisStatus ||
                "idle",
              geminiAnalysisError:
                item.geminiAnalysisError,
              geminiThumbnailTimestampSeconds:
                item.geminiThumbnailTimestampSeconds,
              geminiThumbnailReason:
                item.geminiThumbnailReason,
              geminiAnalyzedAt:
                item.geminiAnalyzedAt,
              thumbnailAssetId:
                item.thumbnailAssetId,
              thumbnailGenerationStatus:
                item.thumbnailGenerationStatus ||
                existing?.thumbnailGenerationStatus ||
                "idle",
              thumbnailGenerationError:
                item.thumbnailGenerationError,
              thumbnailTimestampSeconds:
                item.thumbnailTimestampSeconds,
              thumbnailSource:
                item.thumbnailSource,
              file: item.file,
            };
          });
        });
      },
      onUploadValidated: (itemId, assetId, metadata) => {
        const durationSeconds =
          typeof metadata.durationMs === "number" && metadata.durationMs > 0
            ? Math.round(metadata.durationMs / 1000)
            : undefined;
        setTempJobsQueue((prev) =>
          prev.map((j) =>
            j.id === itemId
              ? {
                  ...j,
                  assetId,
                  durationSeconds,
                  uploadValidated: true,
                  uploadProgress: 100,
                }
              : j
          )
        );
      },
    });

    queueControllerRef.current = controller;
    Promise.resolve().then(() => {
      setQueueItems(controller.getItems());
    });

    // Restore cards into tempJobsQueue
    const restored = controller.getItems();
    if (restored.length > 0) {
      const initialJobs: VideoJob[] = restored.map((item) => ({
        id: item.id,
        fileName: item.filename,
        fileSize: (item.size / (1024 * 1024)).toFixed(1) + " MB",
        fileSizeBytes: item.size,
        durationSeconds: item.durationSeconds,
        uploadProgress: item.progressPercent,
        pageId: item.pageId || "",
        contentType: item.contentType || "VIDEO",
        englishTitle: item.englishTitle,
        englishCaption: item.englishCaption,
        hashtags: item.hashtags,
        scheduledTimeKolkata: item.scheduledTimeKolkata,
        scheduledTimeUTC: item.scheduledTimeUTC,
        status: "DRAFT",
        retryCount: 0,
        thumbnailMode: item.thumbnailMode,
        customThumbnailUrl: item.customThumbnailUrl,
        capturedThumbnailUrl: item.capturedThumbnailUrl,
        localMediaUrl: item.localMediaUrl || item.localVideoUrl,
        localVideoUrl: item.localVideoUrl || (item.contentType !== "PHOTO" ? item.localMediaUrl : undefined),
        assetId: item.assetId,
        uploadValidated: item.status === 'VALIDATED',
        geminiAnalysisStatus:
          item.geminiAnalysisStatus || "idle",
        geminiAnalysisError:
          item.geminiAnalysisError,
        geminiThumbnailTimestampSeconds:
          item.geminiThumbnailTimestampSeconds,
        geminiThumbnailReason:
          item.geminiThumbnailReason,
        geminiAnalyzedAt:
          item.geminiAnalyzedAt,
        thumbnailAssetId:
          item.thumbnailAssetId,
        thumbnailGenerationStatus:
          item.thumbnailGenerationStatus || "idle",
        thumbnailGenerationError:
          item.thumbnailGenerationError,
        thumbnailTimestampSeconds:
          item.thumbnailTimestampSeconds,
        thumbnailSource:
          item.thumbnailSource,
        file: item.file,
      }));
      Promise.resolve().then(() => {
        setTempJobsQueue(initialJobs);
      });
    }

    controller.reconcileRestoredItems();
  }, []);

  const [maxFileSizeMB, setMaxFileSizeMB] = useState(500);
  const [fileUploadError, setFileUploadError] = useState<string | null>(null);

  // Bulk Actions
  const [bulkCaption, setBulkCaption] = useState("");
  const [bulkHashtags, setBulkHashtags] = useState("");
  const [bulkPageId, setBulkPageId] = useState(INITIAL_PAGES[0]?.id || "");
  const [bulkContentType, setBulkContentType] = useState<"VIDEO" | "REEL">("VIDEO");

  // Scheduling inputs
  const [schedulingMode, setSchedulingMode] = useState<"individual" | "interval" | "slots" | "random_windows">("individual");
  const [intervalStartKolkata, setIntervalStartKolkata] = useState("2026-07-13T09:00");
  const [intervalHours, setIntervalHours] = useState(2);
  const [dailySlotsStartDate, setDailySlotsStartDate] = useState("2026-07-13");
  const [dailyTimeSlots, setDailyTimeSlots] = useState<string[]>(["09:00", "15:00", "21:00"]);
  const [newSlotInput, setNewSlotInput] = useState("");
  const [randomWindowsStartDate, setRandomWindowsStartDate] = useState(
    () => getCurrentKolkataDateString(),
  );
  const [randomTimeWindows, setRandomTimeWindows] = useState<RandomTimeWindow[]>([
    { id: "random-window-1", startTime: "04:00", endTime: "04:15" },
    { id: "random-window-2", startTime: "07:00", endTime: "07:15" },
  ]);
  const [newRandomWindowStart, setNewRandomWindowStart] = useState("10:00");
  const [newRandomWindowEnd, setNewRandomWindowEnd] = useState("10:15");
  const [randomPostsPerWindow, setRandomPostsPerWindow] = useState(1);
  const [randomMinimumGapMinutes, setRandomMinimumGapMinutes] = useState(5);
  const [randomOverwriteExisting, setRandomOverwriteExisting] = useState(false);
  const [randomSchedulePreview, setRandomSchedulePreview] = useState<RandomSchedulePreview | null>(null);
  const [randomScheduleErrors, setRandomScheduleErrors] = useState<string[]>([]);
  const [randomScheduleUndo, setRandomScheduleUndo] = useState<RandomScheduleUndoEntry[] | null>(null);
  const [randomScheduleLastResult, setRandomScheduleLastResult] = useState<string | null>(null);

  // CSV Import/Validation States
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvSuccessCount, setCsvSuccessCount] = useState<number>(0);

  // Phase 7E bulk title/caption assignment
  const [bulkMetadataSource, setBulkMetadataSource] = useState<"paste" | "csv">("paste");
  const [bulkTitlesText, setBulkTitlesText] = useState("");
  const [bulkCaptionsText, setBulkCaptionsText] = useState("");
  const [bulkMetadataCsvRows, setBulkMetadataCsvRows] = useState<BulkMetadataRow[]>([]);
  const [bulkMetadataCsvFileName, setBulkMetadataCsvFileName] = useState("");
  const [bulkMetadataMatchMode, setBulkMetadataMatchMode] = useState<BulkMetadataMatchMode>("upload_order");
  const [bulkMetadataOverwriteExisting, setBulkMetadataOverwriteExisting] = useState(false);
  const [bulkMetadataPreview, setBulkMetadataPreview] = useState<BulkMetadataPreview | null>(null);
  const [bulkMetadataErrors, setBulkMetadataErrors] = useState<string[]>([]);
  const [bulkMetadataUndo, setBulkMetadataUndo] = useState<BulkMetadataUndoEntry[] | null>(null);
  const [bulkMetadataLastResult, setBulkMetadataLastResult] = useState<string | null>(null);

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

  // Validate single job
  const getJobValidationErrors = (job: VideoJob, currentQueue: VideoJob[]): string[] => {
    const errors: string[] = [];

    // Title checks
    if (!job.englishTitle.trim()) {
      errors.push("Title is required.");
    } else if (countUnicodeCharacters(job.englishTitle) > 255) {
      errors.push("Title exceeds the 255 Unicode-character limit.");
    } else if (!isSingleLineMetadataText(job.englishTitle)) {
      errors.push("Title must be a single line.");
    } else if (containsUnsafeControlCharacters(job.englishTitle)) {
      errors.push("Title contains unsupported control characters.");
    }

    // Caption checks
    if (
      job.englishCaption &&
      containsUnsafeControlCharacters(job.englishCaption)
    ) {
      errors.push("Caption contains unsupported control characters.");
    }

    // File type limits
    const mediaDescriptor = getSupportedMediaDescriptor(job.fileName);
    if (!mediaDescriptor) {
      errors.push("Unsupported file type. Use MP4, MOV, JPG, JPEG, PNG, or WebP.");
    } else if (job.contentType === "PHOTO" && mediaDescriptor.kind !== "image") {
      errors.push("Facebook Photo requires a JPG, JPEG, PNG, or WebP image.");
    } else if (job.contentType !== "PHOTO" && mediaDescriptor.kind !== "video") {
      errors.push("Facebook Video or Reel requires an MP4 or MOV video.");
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

    // Persistent GCS/R2 validation
    if (!job.uploadValidated || !job.assetId) {
      errors.push("Media must be successfully uploaded and validated.");
    }

    if (job.contentType !== "PHOTO" && job.thumbnailMode === "custom") {
      errors.push(
        "Custom image thumbnails are not yet available for permanent scheduling. Use Facebook Auto, Ollama Best, or Manual Frame.",
      );
    }

    if (job.contentType !== "PHOTO" && job.thumbnailMode === "captured") {
      if (job.thumbnailGenerationStatus === "generating") {
        errors.push("Wait for permanent thumbnail generation to finish.");
      } else if (!job.thumbnailAssetId) {
        errors.push("Captured thumbnail must be generated and stored before scheduling.");
      }
    }

    // Page selection check
    if (!job.pageId) {
      errors.push("Destination Facebook Page is required.");
    } else {
      const pageExists = pages.some((p) => p.id === job.pageId);
      if (!pageExists) {
        errors.push("Invalid Facebook Page selection.");
      }
    }

    return errors;
  };

  // Drag and Drop/Picker File Selection handler
  const handleBulkFilesSelect = (filesList: FileList) => {
    setFileUploadError(null);

    if (!bulkPageId || !pages.some((page) => page.id === bulkPageId)) {
      setFileUploadError(
        "Select a connected Facebook Page before adding files. Every newly selected file will inherit that page.",
      );
      return;
    }

    const filesArray = Array.from(filesList);
    if (filesArray.length === 0) {
      return;
    }

    if (queueControllerRef.current) {
      queueControllerRef.current.addFiles(
        filesArray,
        bulkPageId,
        maxFileSizeMB,
      );
    }
  };

  // File Picker wrapper
  const triggerPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleBulkFilesSelect(e.target.files);
    }

    // Permit selecting the same file again after removing its previous card.
    e.target.value = "";
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

  const updateTempJobFields = (
    jobId: string,
    fields: Partial<VideoJob>,
  ) => {
    setTempJobsQueue((prev) =>
      prev.map((job) =>
        job.id === jobId
          ? { ...job, ...fields }
          : job,
      ),
    );

    queueControllerRef.current?.updateJobFields(
      jobId,
      fields as Partial<QueueItem>,
    );
  };

  // Update fields inside publisher queue
  const handleUpdateTempJobField = (
    jobId: string,
    field: keyof VideoJob,
    value: string | number | boolean | undefined,
  ) => {
    const fields: Partial<VideoJob> = {
      [field]: value,
    };

    if (field === "scheduledTimeKolkata") {
      fields.scheduledTimeUTC = convertKolkataToUTC(
        value as string,
      );
      setRandomSchedulePreview(null);
      setRandomScheduleErrors([]);
      setRandomScheduleLastResult(null);
    }

    updateTempJobFields(jobId, fields);
  };

  const captureFrameFromVideoUrl = async (
    videoUrl: string,
    timestampSeconds: number,
  ): Promise<string> => {
    return await new Promise<string>(
      (resolve, reject) => {
        const video = document.createElement("video");
        let settled = false;
        let timeoutId = 0;

        const cleanup = () => {
          window.clearTimeout(timeoutId);
          video.removeAttribute("src");
          video.load();
        };

        const finishWithError = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        timeoutId = window.setTimeout(
          () => {
            finishWithError(
              new Error(
                "Timed out while capturing the Gemini-selected frame.",
              ),
            );
          },
          20_000,
        );

        const capture = () => {
          if (settled) return;

          if (
            video.videoWidth <= 0 ||
            video.videoHeight <= 0
          ) {
            finishWithError(
              new Error(
                "The selected video frame is unavailable.",
              ),
            );
            return;
          }

          const maximumDimension = 1280;
          const scale = Math.min(
            1,
            maximumDimension /
              Math.max(
                video.videoWidth,
                video.videoHeight,
              ),
          );

          const canvas = document.createElement("canvas");
          canvas.width = Math.max(
            1,
            Math.round(video.videoWidth * scale),
          );
          canvas.height = Math.max(
            1,
            Math.round(video.videoHeight * scale),
          );

          const context = canvas.getContext("2d");

          if (!context) {
            finishWithError(
              new Error(
                "The browser could not create a thumbnail canvas.",
              ),
            );
            return;
          }

          context.drawImage(
            video,
            0,
            0,
            canvas.width,
            canvas.height,
          );

          const dataUrl = canvas.toDataURL(
            "image/jpeg",
            0.86,
          );

          settled = true;
          cleanup();
          resolve(dataUrl);
        };

        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;

        video.addEventListener(
          "error",
          () => {
            finishWithError(
              new Error(
                "The local video preview could not be loaded.",
              ),
            );
          },
          { once: true },
        );

        video.addEventListener(
          "loadedmetadata",
          () => {
            const duration = Number.isFinite(video.duration)
              ? video.duration
              : timestampSeconds;
            const maximumTime = Math.max(
              0,
              duration - 0.05,
            );
            const safeTimestamp = Math.min(
              Math.max(timestampSeconds, 0),
              maximumTime,
            );

            if (safeTimestamp <= 0.01) {
              if (video.readyState >= 2) {
                capture();
              } else {
                video.addEventListener(
                  "loadeddata",
                  capture,
                  { once: true },
                );
              }
              return;
            }

            video.addEventListener(
              "seeked",
              capture,
              { once: true },
            );
            video.currentTime = safeTimestamp;
          },
          { once: true },
        );

        video.src = videoUrl;
        video.load();
      },
    );
  };

  const handleGeneratePersistedThumbnail = async (input: {
    jobId: string;
    assetId: string;
    fileName: string;
    timestampSeconds: number;
    source: DashboardThumbnailSource;
  }): Promise<boolean> => {
    updateTempJobFields(input.jobId, {
      thumbnailMode: "captured",
      thumbnailAssetId: undefined,
      thumbnailGenerationStatus: "generating",
      thumbnailGenerationError: undefined,
      thumbnailTimestampSeconds: input.timestampSeconds,
      thumbnailSource: input.source,
    });

    try {
      const response = await fetch(
        buildThumbnailGenerationUrl(input.assetId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timestampSeconds: input.timestampSeconds,
            source: input.source,
          }),
        },
      );

      let payload: unknown = null;

      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(
          getThumbnailGenerationErrorMessage(
            response.status,
            payload,
          ),
        );
      }

      const result = parseThumbnailGenerationResponse(
        payload,
        input.assetId,
      );

      if (result.thumbnail.source !== input.source) {
        throw new Error(
          "Thumbnail service returned a different source type.",
        );
      }

      updateTempJobFields(input.jobId, {
        thumbnailMode: "captured",
        thumbnailAssetId: result.thumbnail.id,
        thumbnailGenerationStatus: "complete",
        thumbnailGenerationError: undefined,
        thumbnailTimestampSeconds:
          result.thumbnail.timestampSeconds,
        thumbnailSource: result.thumbnail.source,
      });

      addSecurityLog(
        "INFO",
        `${result.reused ? "Reused" : "Generated"} permanent thumbnail at ${result.thumbnail.timestampSeconds.toFixed(2)}s for ${input.fileName}.`,
        input.jobId,
      );

      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Permanent thumbnail generation failed.";

      updateTempJobFields(input.jobId, {
        thumbnailAssetId: undefined,
        thumbnailGenerationStatus: "error",
        thumbnailGenerationError: message,
      });

      addSecurityLog(
        "ERROR",
        `Permanent thumbnail generation failed for ${input.fileName}: ${message}`,
        input.jobId,
      );

      return false;
    }
  };

  const handleAnalyzeJobWithGemini = async (
    job: VideoJob,
    options?: {
      forceThumbnailSelection?: boolean;
    },
  ): Promise<boolean> => {
    if (!job.uploadValidated || !job.assetId) {
      alert(
        "Wait until this media file finishes uploading and validation.",
      );
      return false;
    }

    if (job.geminiAnalysisStatus === "analyzing" || activeAnalysisAborts.current[job.id] !== undefined) {
      return false;
    }

    updateTempJobFields(job.id, {
      geminiAnalysisStatus: "analyzing",
      geminiAnalysisError: undefined,
    });

    const controller = new AbortController();
    activeAnalysisAborts.current[job.id] = controller;

    try {
      const response = await fetch(
        buildGeminiAnalysisUrl(job.assetId) + "-stream",
        {
          method: "POST",
          signal: controller.signal,
        }
      );

      let payload: unknown = null;

      if (!response.ok) {
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        throw new Error(
          getGeminiAnalysisErrorMessage(
            response.status,
            payload,
          ),
        );
      }

      validateStreamResponseContentType(response);

      let analysisResult: unknown = null;

      await parseAnalysisStream(response, {
        onReady() {
          // Heartbeats / ready events are not errors
        },
        onResult(result) {
          const res = result as {
            success: boolean;
            analysis: {
              title: string;
              caption: string;
              hashtags: string[];
              thumbnailTimestampSeconds: number;
              thumbnailReason: string;
            };
          };
          if (res && res.success) {
            analysisResult = res.analysis;
          }
        },
        onError(err) {
          const errorObj = err as { message?: string };
          throw new Error(errorObj?.message || "AI could not analyze this media file.");
        },
      });

      if (!analysisResult) {
        throw new Error(
          "The AI analysis connection ended before completion. Please try again."
        );
      }

      const finalResult = analysisResult as {
        title: string;
        caption: string;
        hashtags: string[];
        thumbnailTimestampSeconds: number;
        thumbnailReason: string;
      };

      const isPhoto = job.contentType === "PHOTO";
      const applyOllamaThumbnail =
        !isPhoto &&
        shouldApplyOllamaThumbnail({
          thumbnailMode: job.thumbnailMode,
          thumbnailSource: job.thumbnailSource,
          force: options?.forceThumbnailSelection,
        });
      const updates: Partial<VideoJob> = {
        englishTitle: finalResult.title,
        englishCaption: finalResult.caption,
        hashtags: finalResult.hashtags.join(" "),
        geminiAnalysisStatus: "complete",
        geminiAnalysisError: undefined,
        geminiAnalyzedAt: new Date().toISOString(),
        geminiThumbnailTimestampSeconds:
          isPhoto
            ? undefined
            : finalResult.thumbnailTimestampSeconds,
        geminiThumbnailReason:
          isPhoto
            ? undefined
            : finalResult.thumbnailReason,
        ...(applyOllamaThumbnail
          ? {
              thumbnailMode: "captured" as const,
              thumbnailAssetId: undefined,
              thumbnailGenerationStatus: "idle" as const,
              thumbnailGenerationError: undefined,
              thumbnailTimestampSeconds:
                finalResult.thumbnailTimestampSeconds,
              thumbnailSource:
                "GEMINI_FRAME" as const,
            }
          : {}),
      };

      if (
        applyOllamaThumbnail &&
        job.localVideoUrl
      ) {
        try {
          const capturedThumbnailUrl =
            await captureFrameFromVideoUrl(
              job.localVideoUrl,
              finalResult.thumbnailTimestampSeconds,
            );

          updates.capturedThumbnailUrl =
            capturedThumbnailUrl;
        } catch (captureError) {
          addSecurityLog(
            "WARN",
            captureError instanceof Error
              ? captureError.message
              : "The AI-selected local frame could not be captured.",
            job.id,
          );
        }
      }

      updateTempJobFields(job.id, updates);

      if (isPhoto) {
        addSecurityLog(
          "INFO",
          `AI generated title, caption, and five hashtags for ${job.fileName}.`,
          job.id,
        );
        return true;
      }

      if (!applyOllamaThumbnail) {
        const preservedSelection =
          job.thumbnailMode === "custom"
            ? "the custom JPG selection"
            : job.thumbnailSource === "MANUAL_FRAME"
              ? "the manual frame selection"
              : "Facebook Auto";

        addSecurityLog(
          "INFO",
          `AI updated English content for ${job.fileName} and preserved ${preservedSelection}.`,
          job.id,
        );
        return true;
      }

      const thumbnailStored =
        await handleGeneratePersistedThumbnail({
          jobId: job.id,
          assetId: job.assetId,
          fileName: job.fileName,
          timestampSeconds:
            finalResult.thumbnailTimestampSeconds,
          source: "GEMINI_FRAME",
        });

      addSecurityLog(
        "INFO",
        `AI generated content and selected thumbnail timestamp ${finalResult.thumbnailTimestampSeconds.toFixed(2)}s for ${job.fileName}.`,
        job.id,
      );

      return thumbnailStored;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return false;
      }

      const message =
        error instanceof Error
          ? error.message
          : "AI could not analyze this media file.";

      updateTempJobFields(job.id, {
        geminiAnalysisStatus: "error",
        geminiAnalysisError: message,
      });

      addSecurityLog(
        "ERROR",
        `AI analysis failed for ${job.fileName}: ${message}`,
        job.id,
      );

      return false;
    } finally {
      if (activeAnalysisAborts.current[job.id] === controller) {
        delete activeAnalysisAborts.current[job.id];
      }
    }
  };

  const handleUseOllamaBestFrame = async (
    job: VideoJob,
  ): Promise<void> => {
    updateTempJobFields(job.id, {
      thumbnailMode: "captured",
      thumbnailAssetId: undefined,
      thumbnailGenerationStatus: "idle",
      thumbnailGenerationError: undefined,
      thumbnailTimestampSeconds: undefined,
      thumbnailSource: "GEMINI_FRAME",
    });

    await handleAnalyzeJobWithGemini(
      job,
      {
        forceThumbnailSelection: true,
      },
    );
  };

  const handleCancelBulkAnalysis = () => {
    if (batchAbortControllerRef.current) {
      batchAbortControllerRef.current.abort();
      batchAbortControllerRef.current = null;
    }
  };

  const handleAnalyzeAllValidated = async (regenerate = false) => {
    if (isBulkGeminiAnalysisRunning) return;

    const eligibleJobs = tempJobsQueue.filter((job) => {
      const isEligible = job.uploadValidated && job.assetId;
      if (!isEligible) return false;
      if (job.geminiAnalysisStatus === "analyzing" || job.geminiAnalysisStatus === "queued") return false;
      if (!regenerate && job.geminiAnalysisStatus === "complete") return false;
      return true;
    });

    if (eligibleJobs.length === 0) {
      alert("No validated media files are ready for AI analysis.");
      return;
    }

    if (regenerate) {
      if (!confirm("Are you sure you want to regenerate AI content for all validated media files? This will overwrite existing AI content.")) {
        return;
      }
    }

    setIsBulkGeminiAnalysisRunning(true);
    setActiveBatchAssetIds(eligibleJobs.map((j) => j.assetId!));
    setBulkStatus({
      active: 0,
      completed: 0,
      failed: 0,
      total: eligibleJobs.length,
      cancelled: 0,
    });

    eligibleJobs.forEach((job) => {
      updateTempJobFields(job.id, {
        geminiAnalysisStatus: "queued",
        geminiAnalysisError: undefined,
      });
    });

    const controller = new AbortController();
    batchAbortControllerRef.current = controller;

    try {
      const response = await fetch("/api/uploads/analyze-batch-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assetIds: eligibleJobs.map((j) => j.assetId),
          regenerateCompleted: regenerate,
          concurrency: 2,
        }),
        signal: controller.signal,
      });

      validateStreamResponseContentType(response);

      await parseAnalysisStream(response, {
        onBatchReady(raw: unknown) {
          const data = raw as { total: number };
          setBulkStatus((prev) => {
            if (!prev) return null;
            return { ...prev, total: data.total };
          });
        },
        onItemQueued(raw: unknown) {
          const data = raw as { assetId: string };
          const targetJob = eligibleJobs.find((j) => j.assetId === data.assetId);
          if (targetJob) {
            updateTempJobFields(targetJob.id, {
              geminiAnalysisStatus: "queued",
              geminiAnalysisError: undefined,
            });
          }
        },
        onItemStarted(raw: unknown) {
          const data = raw as { assetId: string; active: number; completed: number; failed: number; total: number };
          const targetJob = eligibleJobs.find((j) => j.assetId === data.assetId);
          if (targetJob) {
            updateTempJobFields(targetJob.id, {
              geminiAnalysisStatus: "analyzing",
              geminiAnalysisError: undefined,
            });
          }
          setBulkStatus((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              active: data.active,
              completed: data.completed,
              failed: data.failed,
              total: data.total,
            };
          });
        },
        onItemResult(raw: unknown) {
          const data = raw as {
            assetId: string;
            analysis: {
              title: string;
              caption: string;
              hashtags: string[];
              thumbnailTimestampSeconds: number;
              thumbnailReason?: string;
            };
            completed: number;
            failed: number;
            total: number;
          };
          const { assetId, analysis, completed, failed, total } = data;
          const targetJob = eligibleJobs.find((j) => j.assetId === assetId);
          if (targetJob) {
            const finalResult = analysis;
            const isPhoto = targetJob.contentType === "PHOTO";
            const applyOllamaThumbnail =
              !isPhoto &&
              shouldApplyOllamaThumbnail({
                thumbnailMode:
                  targetJob.thumbnailMode,
                thumbnailSource:
                  targetJob.thumbnailSource,
              });
            const updates: Partial<VideoJob> = {
              englishTitle: finalResult.title,
              englishCaption: finalResult.caption,
              hashtags: finalResult.hashtags.join(" "),
              geminiAnalysisStatus: "complete",
              geminiAnalysisError: undefined,
              geminiAnalyzedAt: new Date().toISOString(),
              geminiThumbnailTimestampSeconds:
                isPhoto
                  ? undefined
                  : finalResult.thumbnailTimestampSeconds,
              geminiThumbnailReason:
                isPhoto
                  ? undefined
                  : finalResult.thumbnailReason || "AI recommended thumbnail frame.",
              ...(applyOllamaThumbnail
                ? {
                    thumbnailMode: "captured" as const,
                    thumbnailAssetId: undefined,
                    thumbnailGenerationStatus: "idle" as const,
                    thumbnailGenerationError: undefined,
                    thumbnailTimestampSeconds:
                      finalResult.thumbnailTimestampSeconds,
                    thumbnailSource:
                      "GEMINI_FRAME" as const,
                  }
                : {}),
            };

            const localVideoUrl = targetJob.localVideoUrl;
            if (
              applyOllamaThumbnail &&
              localVideoUrl
            ) {
              void (async () => {
                try {
                  const capturedThumbnailUrl = await captureFrameFromVideoUrl(
                    localVideoUrl,
                    finalResult.thumbnailTimestampSeconds
                  );
                  updateTempJobFields(targetJob.id, { capturedThumbnailUrl });
                } catch (captureError) {
                  addSecurityLog(
                    "WARN",
                    captureError instanceof Error
                      ? captureError.message
                      : "The AI-selected local frame could not be captured.",
                    targetJob.id
                  );
                }
              })();
            }

            updateTempJobFields(targetJob.id, updates);

            if (isPhoto) {
              addSecurityLog(
                "INFO",
                `AI generated title, caption, and five hashtags for ${targetJob.fileName}.`,
                targetJob.id,
              );
            } else if (applyOllamaThumbnail) {
              void (async () => {
                try {
                  await handleGeneratePersistedThumbnail({
                    jobId: targetJob.id,
                    assetId: targetJob.assetId!,
                    fileName: targetJob.fileName,
                    timestampSeconds: finalResult.thumbnailTimestampSeconds,
                    source: "GEMINI_FRAME",
                  });
                  addSecurityLog(
                    "INFO",
                    `AI generated content and selected thumbnail timestamp ${finalResult.thumbnailTimestampSeconds.toFixed(2)}s for ${targetJob.fileName}.`,
                    targetJob.id
                  );
                } catch (persistError) {
                  console.error("Failed to generate permanent thumbnail:", persistError);
                }
              })();
            } else {
              const preservedSelection =
                targetJob.thumbnailMode === "custom"
                  ? "the custom JPG selection"
                  : targetJob.thumbnailSource === "MANUAL_FRAME"
                    ? "the manual frame selection"
                    : "Facebook Auto";

              addSecurityLog(
                "INFO",
                `AI updated English content for ${targetJob.fileName} and preserved ${preservedSelection}.`,
                targetJob.id,
              );
            }
          }

          setBulkStatus((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              completed,
              failed,
              total,
              active: Math.max(0, prev.active - 1),
            };
          });
        },
        onItemError(raw: unknown) {
          const data = raw as { assetId: string; code: string; message: string; completed: number; failed: number; total: number };
          const { assetId, code, message, completed, failed, total } = data;
          const targetJob = eligibleJobs.find((j) => j.assetId === assetId);
          if (targetJob) {
            updateTempJobFields(targetJob.id, {
              geminiAnalysisStatus: "error",
              geminiAnalysisError: message,
            });
            addSecurityLog(
              "ERROR",
              `AI analysis failed for ${targetJob.fileName}: ${message} (${code})`,
              targetJob.id
            );
          }

          setBulkStatus((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              completed,
              failed,
              total,
              active: Math.max(0, prev.active - 1),
            };
          });
        },
        onBatchComplete(raw: unknown) {
          const data = raw as { succeeded: number; failed: number; total: number; cancelled: number };
          setBulkStatus((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              completed: data.succeeded,
              failed: data.failed,
              total: data.total,
              cancelled: data.cancelled,
              active: 0,
            };
          });
          addSecurityLog(
            "INFO",
            `AI bulk analysis completed for ${data.succeeded} of ${data.total} validated media files.`,
          );
        },
        onError(err: unknown) {
          console.error("Batch stream error:", err);
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        eligibleJobs.forEach((job) => {
          if (job.geminiAnalysisStatus === "queued" || job.geminiAnalysisStatus === "analyzing") {
            updateTempJobFields(job.id, {
              geminiAnalysisStatus: "cancelled",
            });
          }
        });
      } else {
        alert(error instanceof Error ? error.message : "An error occurred during bulk analysis.");
      }
    } finally {
      setIsBulkGeminiAnalysisRunning(false);
      setActiveBatchAssetIds([]);
      batchAbortControllerRef.current = null;
    }
  };

  // Delete draft from queue
  const handleDeleteDraft = (id: string) => {
    if (activeAnalysisAborts.current[id]) {
      activeAnalysisAborts.current[id].abort();
      delete activeAnalysisAborts.current[id];
    }
    setTempJobsQueue((prev) => prev.filter((j) => j.id !== id));
    queueControllerRef.current?.removeItem(id);
  };

  // ==========================================
  // BULK ACTIONS
  // ==========================================
  const handleApplyCaptionToAll = () => {
    setTempJobsQueue((prev) => prev.map((j) => ({ ...j, englishCaption: bulkCaption })));
    tempJobsQueue.forEach((job) => {
      queueControllerRef.current?.updateJobFields(job.id, { englishCaption: bulkCaption });
    });
    addSecurityLog("INFO", `Bulk applied caption to all ${tempJobsQueue.length} draft items.`);
  };

  const handleAppendHashtagsToAll = () => {
    setTempJobsQueue((prev) =>
      prev.map((j) => {
        const cleanedJobHash = j.hashtags ? j.hashtags.trim() : "";
        const cleanedBulkHash = bulkHashtags ? bulkHashtags.trim() : "";
        const finalHashtags = cleanedJobHash ? `${cleanedJobHash} ${cleanedBulkHash}` : cleanedBulkHash;

        queueControllerRef.current?.updateJobFields(j.id, { hashtags: finalHashtags });

        return {
          ...j,
          hashtags: finalHashtags,
        };
      })
    );
    addSecurityLog("INFO", `Bulk appended hashtags to all ${tempJobsQueue.length} draft items.`);
  };

  const handleReplaceHashtagsToAll = () => {
    setTempJobsQueue((prev) => prev.map((j) => ({ ...j, hashtags: bulkHashtags })));
    tempJobsQueue.forEach((job) => {
      queueControllerRef.current?.updateJobFields(job.id, { hashtags: bulkHashtags });
    });
    addSecurityLog("INFO", `Bulk replaced hashtags on all ${tempJobsQueue.length} draft items.`);
  };

  const handleApplyPageToAll = () => {
    if (!bulkPageId || !pages.some((page) => page.id === bulkPageId)) {
      alert("Select a connected Facebook Page first.");
      return;
    }

    setTempJobsQueue((prev) => prev.map((j) => ({ ...j, pageId: bulkPageId })));
    tempJobsQueue.forEach((job) => {
      queueControllerRef.current?.updateJobFields(job.id, { pageId: bulkPageId });
    });
    addSecurityLog("INFO", `Bulk assigned page ID ${bulkPageId} to all ${tempJobsQueue.length} draft items.`);
  };

  const handleApplyContentTypeToAll = () => {
    setTempJobsQueue((prev) =>
      prev.map((job) =>
        job.contentType === "PHOTO"
          ? job
          : { ...job, contentType: bulkContentType },
      ),
    );
    tempJobsQueue.forEach((job) => {
      if (job.contentType !== "PHOTO") {
        queueControllerRef.current?.updateJobFields(job.id, { contentType: bulkContentType });
      }
    });
    const videoCount = tempJobsQueue.filter((job) => job.contentType !== "PHOTO").length;
    addSecurityLog("INFO", `Bulk assigned content type ${bulkContentType} to ${videoCount} video draft items. Photo items remained Facebook Photos.`);
  };

  const clearBulkMetadataPreview = () => {
    setBulkMetadataPreview(null);
    setBulkMetadataLastResult(null);
  };

  const handleBulkMetadataSourceChange = (
    source: "paste" | "csv",
  ) => {
    setBulkMetadataSource(source);
    setBulkMetadataErrors([]);
    clearBulkMetadataPreview();

    if (source === "paste") {
      setBulkMetadataMatchMode("upload_order");
    }
  };

  const handleBulkMetadataTextFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
    field: "title" | "caption",
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const text = await file.text();

      if (field === "title") {
        setBulkTitlesText(text);
      } else {
        setBulkCaptionsText(text);
      }

      setBulkMetadataSource("paste");
      setBulkMetadataMatchMode("upload_order");
      setBulkMetadataErrors([]);
      clearBulkMetadataPreview();
    } catch {
      setBulkMetadataErrors([
        `Could not read ${file.name}. Use a UTF-8 text file.`,
      ]);
    }
  };

  const handleBulkMetadataCsvFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const parsed = parseBulkMetadataCsv(
        await file.text(),
      );

      setBulkMetadataSource("csv");
      setBulkMetadataCsvRows(parsed.rows);
      setBulkMetadataCsvFileName(file.name);
      setBulkMetadataErrors(parsed.errors);
      setBulkMetadataMatchMode(
        parsed.hasFilenameColumn
          ? "filename"
          : "upload_order",
      );
      clearBulkMetadataPreview();
    } catch {
      setBulkMetadataCsvRows([]);
      setBulkMetadataCsvFileName("");
      setBulkMetadataErrors([
        `Could not read ${file.name}. Use a UTF-8 CSV file.`,
      ]);
      clearBulkMetadataPreview();
    }
  };

  const handleDownloadBulkMetadataCsvTemplate = () => {
    const template = [
      "filename,title,caption",
      'video_001.mp4,"First title 🔥","First caption with emojis ❤️"',
      'video_002.mp4,"दूसरा शीर्षक","Multilingual caption مرحبا"',
    ].join("\n");

    const blob = new Blob(
      [template],
      {
        type: "text/csv;charset=utf-8;",
      },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "bulk_titles_captions_template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getBulkMetadataRows = (): BulkMetadataRow[] => {
    if (bulkMetadataSource === "csv") {
      return bulkMetadataCsvRows;
    }

    return buildLineSeparatedMetadataRows(
      bulkTitlesText,
      bulkCaptionsText,
    );
  };

  const handlePreviewBulkMetadata = () => {
    if (tempJobsQueue.length === 0) {
      setBulkMetadataErrors([
        "Add media files before previewing bulk metadata.",
      ]);
      setBulkMetadataPreview(null);
      return;
    }

    const rows = getBulkMetadataRows();

    if (rows.length === 0) {
      setBulkMetadataErrors([
        bulkMetadataSource === "csv"
          ? "Upload a CSV containing at least one title or caption."
          : "Paste titles or captions, or upload a TXT file first.",
      ]);
      setBulkMetadataPreview(null);
      return;
    }

    if (
      bulkMetadataSource === "paste" &&
      bulkMetadataMatchMode === "filename"
    ) {
      setBulkMetadataErrors([
        "Pasted and TXT lists are assigned in upload order. Use CSV for filename matching.",
      ]);
      setBulkMetadataPreview(null);
      return;
    }

    const preview = buildBulkMetadataPreview(
      tempJobsQueue.map((job) => ({
        id: job.id,
        fileName: job.fileName,
        title: job.englishTitle,
        caption: job.englishCaption,
      })),
      rows,
      {
        matchMode: bulkMetadataMatchMode,
        overwriteExisting:
          bulkMetadataOverwriteExisting,
      },
    );

    setBulkMetadataPreview(preview);
    setBulkMetadataErrors(preview.errors);
    setBulkMetadataLastResult(null);
  };

  const handleApplyBulkMetadata = () => {
    const preview = bulkMetadataPreview;

    if (
      !preview ||
      preview.assignments.length === 0
    ) {
      setBulkMetadataErrors([
        "Preview the assignment and confirm that at least one card will be updated.",
      ]);
      return;
    }

    const currentJobsById = new Map(
      tempJobsQueue.map((job) => [
        job.id,
        job,
      ]),
    );

    const undoEntries: BulkMetadataUndoEntry[] = [];
    const updates = preview.assignments.flatMap(
      (assignment) => {
        const currentJob =
          currentJobsById.get(
            assignment.jobId,
          );

        if (!currentJob) {
          return [];
        }

        undoEntries.push({
          jobId: currentJob.id,
          englishTitle:
            currentJob.englishTitle,
          englishCaption:
            currentJob.englishCaption,
        });

        const fields: Partial<VideoJob> = {};

        if (
          assignment.title !==
          undefined
        ) {
          fields.englishTitle =
            assignment.title;
        }

        if (
          assignment.caption !==
          undefined
        ) {
          fields.englishCaption =
            assignment.caption;
        }

        return [{
          itemId: currentJob.id,
          fields,
        }];
      },
    );

    if (updates.length === 0) {
      setBulkMetadataErrors([
        "The upload queue changed after preview. Preview again.",
      ]);
      setBulkMetadataPreview(null);
      return;
    }

    const updateMap = new Map(
      updates.map((update) => [
        update.itemId,
        update.fields,
      ]),
    );

    setTempJobsQueue((previous) =>
      previous.map((job) => {
        const fields =
          updateMap.get(job.id);

        return fields
          ? {
              ...job,
              ...fields,
            }
          : job;
      }),
    );

    const persistedCount =
      queueControllerRef.current?.updateManyJobFields(
        updates.map((update) => ({
          itemId: update.itemId,
          fields:
            update.fields as Partial<QueueItem>,
        })),
      ) || 0;

    if (
      persistedCount !==
      updates.length
    ) {
      setBulkMetadataErrors([
        `Updated ${updates.length} visible cards, but only ${persistedCount} queue records were persisted. Refresh the preview before scheduling.`,
      ]);
    } else {
      setBulkMetadataErrors([]);
    }

    setBulkMetadataUndo(undoEntries);
    setBulkMetadataLastResult(
      `Assigned metadata to ${updates.length} upload cards.`,
    );
    setBulkMetadataPreview(null);

    addSecurityLog(
      "INFO",
      `Bulk title/caption assignment updated ${updates.length} draft items using ${bulkMetadataMatchMode === "filename" ? "filename matching" : "upload order"}.`,
    );
  };

  const handleUndoBulkMetadata = () => {
    if (
      !bulkMetadataUndo ||
      bulkMetadataUndo.length === 0
    ) {
      return;
    }

    const undoMap = new Map(
      bulkMetadataUndo.map((entry) => [
        entry.jobId,
        entry,
      ]),
    );

    setTempJobsQueue((previous) =>
      previous.map((job) => {
        const entry =
          undoMap.get(job.id);

        return entry
          ? {
              ...job,
              englishTitle:
                entry.englishTitle,
              englishCaption:
                entry.englishCaption,
            }
          : job;
      }),
    );

    queueControllerRef.current?.updateManyJobFields(
      bulkMetadataUndo.map((entry) => ({
        itemId: entry.jobId,
        fields: {
          englishTitle:
            entry.englishTitle,
          englishCaption:
            entry.englishCaption,
        },
      })),
    );

    setBulkMetadataLastResult(
      `Restored metadata on ${bulkMetadataUndo.length} upload cards.`,
    );
    setBulkMetadataUndo(null);
    setBulkMetadataPreview(null);
    setBulkMetadataErrors([]);

    addSecurityLog(
      "INFO",
      `Undid the most recent bulk title/caption assignment for ${bulkMetadataUndo.length} draft items.`,
    );
  };

  const handleResetBulkMetadataInputs = () => {
    setBulkTitlesText("");
    setBulkCaptionsText("");
    setBulkMetadataCsvRows([]);
    setBulkMetadataCsvFileName("");
    setBulkMetadataErrors([]);
    setBulkMetadataPreview(null);
    setBulkMetadataLastResult(null);
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

  const invalidateRandomSchedulePreview = () => {
    setRandomSchedulePreview(null);
    setRandomScheduleErrors([]);
    setRandomScheduleLastResult(null);
  };

  const handleAddRandomTimeWindow = () => {
    const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (
      !timePattern.test(newRandomWindowStart) ||
      !timePattern.test(newRandomWindowEnd)
    ) {
      setRandomScheduleErrors([
        "Random windows must use 24-hour HH:MM times.",
      ]);
      return;
    }

    setRandomTimeWindows((previous) => [
      ...previous,
      {
        id: `random-window-${Date.now()}-${previous.length + 1}`,
        startTime: newRandomWindowStart,
        endTime: newRandomWindowEnd,
      },
    ]);
    invalidateRandomSchedulePreview();
  };

  const handleRemoveRandomTimeWindow = (windowId: string) => {
    setRandomTimeWindows((previous) =>
      previous.filter((window) => window.id !== windowId),
    );
    invalidateRandomSchedulePreview();
  };

  const handleGenerateRandomSchedulePreview = () => {
    const preview = buildRandomSchedulePreview({
      jobs: tempJobsQueue,
      startDate: randomWindowsStartDate,
      windows: randomTimeWindows,
      postsPerWindow: randomPostsPerWindow,
      minimumGapMinutes: randomMinimumGapMinutes,
      overwriteExisting: randomOverwriteExisting,
    });

    setRandomSchedulePreview(preview);
    setRandomScheduleErrors(preview.errors);

    if (preview.errors.length > 0) {
      setRandomScheduleLastResult(null);
      return;
    }

    setRandomScheduleLastResult(
      `Prepared ${preview.items.length} exact publishing times across ${preview.daysUsed} day${preview.daysUsed === 1 ? "" : "s"}. The preview will not change unless you regenerate it.`,
    );
  };

  const handleApplyRandomSchedulePreview = () => {
    if (
      !randomSchedulePreview ||
      randomSchedulePreview.errors.length > 0 ||
      randomSchedulePreview.items.length === 0
    ) {
      setRandomScheduleErrors([
        "Generate a valid random-time preview before applying it.",
      ]);
      return;
    }

    const currentSignature =
      buildRandomScheduleQueueSignature(tempJobsQueue);

    if (
      currentSignature !==
      randomSchedulePreview.sourceSignature
    ) {
      setRandomScheduleErrors([
        "The upload cards or their times changed after this preview was generated. Generate a fresh preview before applying it.",
      ]);
      setRandomSchedulePreview(null);
      return;
    }

    const previewByJobId = new Map(
      randomSchedulePreview.items.map((item) => [
        item.jobId,
        item,
      ]),
    );
    const undoEntries: RandomScheduleUndoEntry[] = [];

    tempJobsQueue.forEach((job) => {
      if (!previewByJobId.has(job.id)) return;

      undoEntries.push({
        jobId: job.id,
        scheduledTimeKolkata:
          job.scheduledTimeKolkata,
        scheduledTimeUTC:
          job.scheduledTimeUTC,
      });
    });

    const updates = randomSchedulePreview.items.map(
      (item) => ({
        itemId: item.jobId,
        fields: {
          scheduledTimeKolkata:
            item.scheduledTimeKolkata,
          scheduledTimeUTC:
            item.scheduledTimeUTC,
        },
      }),
    );

    setTempJobsQueue((previous) =>
      previous.map((job) => {
        const previewItem =
          previewByJobId.get(job.id);

        return previewItem
          ? {
              ...job,
              scheduledTimeKolkata:
                previewItem.scheduledTimeKolkata,
              scheduledTimeUTC:
                previewItem.scheduledTimeUTC,
            }
          : job;
      }),
    );

    queueControllerRef.current?.updateManyJobFields(
      updates,
    );

    setRandomScheduleUndo(undoEntries);
    setRandomScheduleLastResult(
      `Applied ${updates.length} random-window publishing times and saved them to queue recovery.`,
    );
    setRandomSchedulePreview(null);
    setRandomScheduleErrors([]);

    addSecurityLog(
      "INFO",
      `Assigned ${updates.length} upload cards to randomized publishing windows starting ${randomWindowsStartDate}.`,
    );
  };

  const handleUndoRandomSchedule = () => {
    if (!randomScheduleUndo || randomScheduleUndo.length === 0) {
      return;
    }

    const undoByJobId = new Map(
      randomScheduleUndo.map((entry) => [
        entry.jobId,
        entry,
      ]),
    );

    setTempJobsQueue((previous) =>
      previous.map((job) => {
        const entry = undoByJobId.get(job.id);

        return entry
          ? {
              ...job,
              scheduledTimeKolkata:
                entry.scheduledTimeKolkata,
              scheduledTimeUTC:
                entry.scheduledTimeUTC,
            }
          : job;
      }),
    );

    queueControllerRef.current?.updateManyJobFields(
      randomScheduleUndo.map((entry) => ({
        itemId: entry.jobId,
        fields: {
          scheduledTimeKolkata:
            entry.scheduledTimeKolkata,
          scheduledTimeUTC:
            entry.scheduledTimeUTC,
        },
      })),
    );

    setRandomScheduleLastResult(
      `Restored publishing times on ${randomScheduleUndo.length} upload cards.`,
    );
    setRandomScheduleUndo(null);
    setRandomSchedulePreview(null);
    setRandomScheduleErrors([]);

    addSecurityLog(
      "INFO",
      `Undid the most recent random-window schedule assignment for ${randomScheduleUndo.length} draft items.`,
    );
  };

  // ==========================================
  // LOCAL THUMBNAIL FRAME CAPTURING
  // ==========================================
  const handleOpenFrameCaptureModal = (job: VideoJob) => {
    if (!job.uploadValidated || !job.assetId) {
      alert(
        "Wait until this media file finishes uploading and validation.",
      );
      return;
    }

    const durationSeconds = Math.max(
      job.durationSeconds || 10,
      0.1,
    );
    const maximumTimestamp = Math.max(
      0,
      durationSeconds - 0.05,
    );
    const preferredTimestamp =
      typeof job.thumbnailTimestampSeconds === "number"
        ? job.thumbnailTimestampSeconds
        : Math.min(5, maximumTimestamp);

    setActiveFrameCaptureJobId(job.id);
    setFrameCaptureUrl(job.localVideoUrl || "");
    setFrameCaptureTime(
      Math.min(
        Math.max(preferredTimestamp, 0),
        maximumTimestamp,
      ),
    );
    setFrameCaptureDuration(durationSeconds);
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

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/facebook/jobs");
      if (res.ok) {
        const data = await res.json();
        const mapped = normalizeDashboardJobs(data);
        setJobs(mapped as unknown as VideoJob[]);
      } else {
        console.error("Failed to fetch jobs: status", res.status);
      }
    } catch (error) {
      console.error("Failed to fetch jobs:", error);
    }
  };

  useEffect(() => {
    if (activeTab === "logs") {
      fetch("/api/admin/audit-logs")
        .then(res => {
          if (res.status === 401) {
            window.location.href = "/settings/meta-configuration";
            return null;
          }
          return res.json();
        })
        .then(data => {
          if (data && data.logs) {
            setSecurityLogs(data.logs);
          }
        })
        .catch(err => console.error("Error fetching audit logs:", err));
    } else if (activeTab === "dashboard") {
      setTimeout(() => {
        fetchJobs();
      }, 0);
    }
  }, [activeTab]);

  const fetchConnectionAndPages = async () => {
    try {
      const res = await fetch("/api/facebook/pages");
      if (res.ok) {
        const data = await res.json();
        setIsConfigured(data.isConfigured);
        setPublicAppUrl(data.publicAppUrl || "");
        setFacebookAppId(data.facebookAppId || "");

        if (data.isConfigured === false) {
          window.location.href = "/settings/meta-configuration?error=not_configured";
          return;
        }
        setAccounts(data.accounts || []);

        // Flatten pages across all accounts to keep page.tsx components fully compatible
        const allPages: FacebookPage[] = [];
        (data.accounts || []).forEach((acc: FacebookAccountUI) => {
          (acc.pages || []).forEach((p: FacebookPage) => {
            allPages.push({
              ...p,
              accountId: acc.id,
              accountName: acc.name
            });
          });
        });
        setPages(allPages);

        if (allPages.length > 0) {
          setBulkPageId((prev) => {
            if (!prev || !allPages.some((p) => p.id === prev)) {
              return allPages[0].id;
            }
            return prev;
          });

          setTempJobsQueue((prev) =>
            prev.map((job) => {
              if (!job.pageId || !allPages.some((p) => p.id === job.pageId)) {
                queueControllerRef.current?.updateJobFields(job.id, {
                  pageId: allPages[0].id
                } as Partial<QueueItem>);
                return { ...job, pageId: allPages[0].id };
              }
              return job;
            })
          );
        }

        // Compute overall reconnection required status from accounts list
        const isReconnectionRequired = (data.accounts || []).some(
          (acc: FacebookAccountUI) => acc.connectionState === "Reconnection Required"
        );

        const hasExpired = allPages.some((p: FacebookPage) => p.tokenStatus === "Expired");
        setSimulateTokenExpiry(hasExpired || isReconnectionRequired);
      }
    } catch (error) {
      console.error("Failed to fetch connection and pages:", error);
    }
  };

  useEffect(() => {
    // Run asynchronously to satisfy the eslint react-hooks/set-state-in-effect rule
    setTimeout(() => {
      fetchConnectionAndPages();
      fetchJobs();

      // Check query params for status messages
      const params = new URLSearchParams(window.location.search);
      if (params.has("success")) {
        const type = params.get("success");
        if (type === "oauth_simulated") {
          addSecurityLog("INFO", "Successfully connected Facebook account via simulation OAuth.");
        }
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (params.has("error")) {
        const err = params.get("error");
        const msg = params.get("message") || "";
        addSecurityLog("ERROR", `Facebook OAuth connection failed: ${err}. ${msg}`);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }, 0);
  }, []);

  const handleCaptureFrameAction = async () => {
    const jobId = activeFrameCaptureJobId;

    if (!jobId) {
      return;
    }

    const job = tempJobsQueue.find(
      (item) => item.id === jobId,
    );

    if (!job?.assetId || !job.uploadValidated) {
      alert(
        "Wait until this media file finishes uploading and validation.",
      );
      return;
    }

    const updates: Partial<VideoJob> = {
      thumbnailMode: "captured",
      thumbnailAssetId: undefined,
      thumbnailGenerationStatus: "idle",
      thumbnailGenerationError: undefined,
      thumbnailTimestampSeconds: frameCaptureTime,
      thumbnailSource: "MANUAL_FRAME",
    };

    const video = videoCaptureRef.current;

    if (
      frameCaptureUrl &&
      video &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext("2d");

      if (!ctx) {
        alert(
          "The browser could not create the local thumbnail preview.",
        );
        return;
      }

      ctx.drawImage(
        video,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      updates.capturedThumbnailUrl =
        canvas.toDataURL("image/jpeg");

      addSecurityLog(
        "INFO",
        `Captured local preview at ${frameCaptureTime.toFixed(1)}s before permanent server-side generation.`,
        jobId,
      );
    } else {
      addSecurityLog(
        "INFO",
        `Selected ${frameCaptureTime.toFixed(1)}s for server-side frame extraction from the stored video.`,
        jobId,
      );
    }

    updateTempJobFields(jobId, updates);
    setActiveFrameCaptureJobId(null);

    await handleGeneratePersistedThumbnail({
      jobId,
      assetId: job.assetId,
      fileName: job.fileName,
      timestampSeconds: frameCaptureTime,
      source: "MANUAL_FRAME",
    });
  };

  // ==========================================
  // CSV BULK IMPORT ENGINE (RFC-COMPLIANT PARSER)
  // ==========================================
  const handleDownloadCsvTemplate = () => {
    const headers = "filename,title,caption,hashtags,page_id,content_type,publish_time,timezone\n";
    const example1 = `ai_trends_2026.mp4,Top 5 AI Tools of 2026 You Must Use,Explore modern AI integrations,#AITools #Tech,1029384756,Video,2026-07-13 10:00,Asia/Kolkata\n`;
    const example2 = `gaming_highlights_ep12.mp4,Insane 1v4 Outplay,Clutch matches highlight clip,#Gaming #Clutch,5647382910,Reel,2026-07-13 14:00,Asia/Kolkata\n`;
    const example3 = `product_launch.jpg,First Look at Our New Launch,See the details in this new photo,#ProductLaunch #NewArrival,1029384756,Photo,2026-07-13 16:00,Asia/Kolkata\n`;

    const blob = new Blob([headers + example1 + example2 + example3], { type: "text/csv;charset=utf-8;" });
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
          errorsAccumulator.push(`Row ${r + 1} (${filename}): Filename not found in current publisher upload queue. Select the media file first.`);
          continue;
        }

        const errorsThisRow: string[] = [];

        // Validation - Empty title
        if (!title) {
          errorsThisRow.push("Title cannot be empty.");
        } else if (countUnicodeCharacters(title) > 255) {
          errorsThisRow.push("Title exceeds the 255 Unicode-character limit.");
        } else if (!isSingleLineMetadataText(title)) {
          errorsThisRow.push("Title must be a single line.");
        } else if (containsUnsafeControlCharacters(title)) {
          errorsThisRow.push("Title contains unsupported control characters.");
        }

        // Validation - Caption
        if (
          caption &&
          containsUnsafeControlCharacters(caption)
        ) {
          errorsThisRow.push("Caption contains unsupported control characters.");
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
        const isPhoto = contentTypeRaw === "PHOTO" || contentTypeRaw === "FACEBOOK PHOTO";
        if (!isReel && !isVideo && !isPhoto) {
          errorsThisRow.push(`Invalid content type '${contentTypeRaw}'. Must be 'Video', 'Reel', or 'Photo'.`);
        }

        const queuedMediaKind = getSupportedMediaDescriptor(filename)?.kind;
        if (isPhoto && queuedMediaKind !== "image") {
          errorsThisRow.push("Photo rows require a JPG, JPEG, PNG, or WebP file.");
        } else if ((isVideo || isReel) && queuedMediaKind !== "video") {
          errorsThisRow.push("Video and Reel rows require an MP4 or MOV file.");
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
            contentType: isPhoto ? "PHOTO" : isReel ? "REEL" : "VIDEO",
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
      alert("No media items in the queue to save.");
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

  const handleConfirmSave = async () => {
    if (isSavingJobs) return;
    setIsSavingJobs(true);
    try {
      const jobsToSave = tempJobsQueue.map((job) => {
        if (!job.assetId) {
          throw new Error(`Upload asset ID is missing for file "${job.fileName}".`);
        }
        if (!job.uploadValidated) {
          throw new Error(`Upload for "${job.fileName}" has not been validated.`);
        }
        return {
          pageId: job.pageId,
          uploadAssetId: job.assetId,
          thumbnailAssetId:
            job.contentType !== "PHOTO" &&
            job.thumbnailMode === "captured"
              ? job.thumbnailAssetId
              : undefined,
          englishTitle: job.englishTitle,
          englishCaption: job.englishCaption,
          hashtags: job.hashtags,
          scheduledTimeUTC: job.scheduledTimeUTC,
          mockScenario: simulationScenario,
          contentType: job.contentType
        };
      });

      const res = await fetch("/api/facebook/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: jobsToSave })
      });

      if (res.ok) {
        addSecurityLog("INFO", `Scheduled ${jobsToSave.length} new bulk media jobs into the database state queue.`);
        setTempJobsQueue([]);
        queueControllerRef.current?.clearAll();
        setIsConfirmationOpen(false);
        await fetchJobs();
        setActiveTab("dashboard");
      } else {
        const errData = await res.json();
        alert("Failed to save scheduled jobs: " + (errData.error || "Unknown Error"));
      }
    } catch (error) {
      console.error("Error saving scheduled jobs:", error);
      alert(error instanceof Error ? error.message : "Network error during job scheduling.");
    } finally {
      setIsSavingJobs(false);
    }
  };

  // Reset Demo Helper (Extended)
  const handleResetDemo = () => {
    setJobs([]);
    handleDisconnect();
    setTempJobsQueue([]);
    queueControllerRef.current?.clearAll();
    setCsvErrors([]);
    setCsvSuccessCount(0);
    setSimulateTokenExpiry(false);
    setSimulationLog([]);
    setCountdownJobs({});
    addSecurityLog("INFO", "Reset simulator demo state (Phase 3/4).");
  };



  const handleSimulateQueueWorker = async () => {
    if (currentUser.role !== 'ADMIN' || process.env.NODE_ENV === 'production') {
      alert("Unauthorized: Worker simulation is disabled in this environment.");
      return;
    }
    setSimulatingPublish(true);
    setSimulationLog(["[Worker] Activating queue worker execution run..."]);
    try {
      const res = await fetch("/api/admin/worker", {
        method: "POST"
      });
      if (res.ok) {
        const data = await res.json();
        setSimulationLog(data.logs || []);
        await fetchJobs();
      } else {
        const errData = await res.json();
        setSimulationLog([`[Worker] [ERROR] Run failed: ${errData.error || "Unknown Error"}`]);
      }
    } catch (error) {
      console.error("Error triggering queue worker:", error);
      setSimulationLog(["[Worker] [ERROR] Network error."]);
    } finally {
      setSimulatingPublish(false);
    }
  };

  const handleSyncPages = async (accountId?: string) => {
    setIsSyncingPages(true);
    addSecurityLog("INFO", accountId
      ? `Initiated managed Facebook Pages synchronization for account ID: ${accountId}.`
      : "Initiated managed Facebook Pages synchronization request."
    );
    try {
      const url = accountId ? `/api/facebook/sync?accountId=${accountId}` : "/api/facebook/sync";
      const res = await fetch(url, { method: "POST" });
      if (res.ok) {
        await fetchConnectionAndPages();
        addSecurityLog("INFO", `Synced pages successfully. Tokens encrypted and saved.`);
      } else {
        const data = await res.json();
        addSecurityLog("ERROR", `Synchronization failed: ${data.error || "Unknown Error"}`);
      }
    } catch (error) {
      console.error("Error during sync:", error);
      addSecurityLog("ERROR", "Network error during Facebook Pages synchronization.");
    } finally {
      setIsSyncingPages(false);
    }
  };

  const handleSimulateTokenExpiry = async (shouldExpire: boolean, accountId?: string) => {
    try {
      const res = await fetch("/api/facebook/simulate-expiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expire: shouldExpire, accountId })
      });
      if (res.ok) {
        addSecurityLog(
          shouldExpire ? "WARN" : "INFO",
          shouldExpire
            ? `Simulated Facebook access token expiration${accountId ? ` for account ${accountId}` : ""}: Triggered Code 190.`
            : `Simulated Facebook access token validation restored${accountId ? ` for account ${accountId}` : ""}.`
        );
        await fetchConnectionAndPages();
      } else {
        addSecurityLog("ERROR", "Failed to update simulated token expiry status.");
      }
    } catch (error) {
      console.error("Error simulating token expiry:", error);
      addSecurityLog("ERROR", "Network error while simulating token expiry.");
    }
  };

  const handleToggleTokenExpiry = async () => {
    const nextState = !simulateTokenExpiry;
    await handleSimulateTokenExpiry(nextState);
  };

  const handleReconnectAccount = async (pageId: string) => {
    try {
      const page = pages.find(p => p.id === pageId);
      const res = await fetch("/api/facebook/simulate-expiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expire: false, accountId: page?.accountId })
      });
      if (res.ok) {
        await fetchConnectionAndPages();
        await fetchJobs();
        alert("Facebook reconnection succeeded.");
        addSecurityLog("INFO", `Reconnected Page Access Token for Page ID: ${pageId} via Mock OAuth.`);
      }
    } catch (error) {
      console.error("Error reconnecting account:", error);
    }
  };

  const handleReconnectAll = async () => {
    try {
      const res = await fetch("/api/facebook/simulate-expiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expire: false })
      });
      if (res.ok) {
        await fetchConnectionAndPages();
        await fetchJobs();
        alert("Facebook reconnection succeeded.");
        addSecurityLog("INFO", "Reconnected all expired Facebook Pages via mock OAuth.");
      }
    } catch (error) {
      console.error("Error reconnecting all:", error);
    }
  };

  const handleDisconnect = async (accountId?: string) => {
    try {
      const url = accountId ? `/api/facebook/disconnect?accountId=${accountId}` : "/api/facebook/disconnect";
      const res = await fetch(url, { method: "POST" });
      if (res.ok) {
        if (accountId) {
          addSecurityLog("INFO", `Disconnected Facebook account ID: ${accountId}.`);
        } else {
          addSecurityLog("INFO", "Disconnected all Facebook account integrations.");
          setPages([]);
          setAccounts([]);
        }
        await fetchConnectionAndPages();
      } else {
        addSecurityLog("ERROR", "Failed to disconnect Facebook account.");
      }
    } catch (error) {
      console.error("Error during disconnect:", error);
      addSecurityLog("ERROR", "Network error during Facebook disconnect.");
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      setCountdownJobs(prev => {
        const updated = { ...prev };
        delete updated[jobId];
        return updated;
      });

      const res = await fetch(`/api/facebook/jobs/${jobId}/cancel`, {
        method: "POST"
      });

      if (res.ok) {
        addSecurityLog("INFO", `Job "${jobId}" was cancelled.`, jobId);
        await fetchJobs();
      } else {
        const errData = await res.json();
        alert("Failed to cancel job: " + (errData.error || "Unknown Error"));
      }
    } catch (error) {
      console.error("Error cancelling job:", error);
    }
  };

  const handleRetryJobManual = async (jobId: string) => {
    try {
      setCountdownJobs(prev => {
        const updated = { ...prev };
        delete updated[jobId];
        return updated;
      });

      // Reschedule job to SCHEDULED
      const retryRes = await fetch(`/api/facebook/jobs/${jobId}/retry`, {
        method: "POST"
      });

      if (!retryRes.ok) {
        const errData = await retryRes.json();
        alert("Failed to retry job: " + (errData.error || "Unknown Error"));
        return;
      }

      addSecurityLog("INFO", `Rescheduled Job "${jobId}" back to SCHEDULED.`, jobId);

      // Instantly trigger mock worker execution on this job
      setSimulatingJobId(jobId);
      setSimulatingPublish(true);
      setSimulationLog([`[Worker] Initiating manual trigger run for Job ${jobId}...`]);

      const triggerRes = await fetch(`/api/facebook/jobs/${jobId}/trigger`, {
        method: "POST"
      });

      if (triggerRes.ok) {
        const data = await triggerRes.json();
        setSimulationLog(data.logs || []);
        await fetchJobs();
      } else {
        const errData = await triggerRes.json();
        setSimulationLog(prev => [...prev, `[ERROR] Trigger failed: ${errData.error || "Unknown Error"}`]);
      }
    } catch (error) {
      console.error("Error retrying job:", error);
    } finally {
      setSimulatingJobId(null);
      setSimulatingPublish(false);
    }
  };



  // Stat calculations
  const countPages = pages.length;
  const countScheduled = jobs.filter((j) => j.status === "SCHEDULED").length;
  const countPublishing = jobs.filter((j) => ["PREPARING", "UPLOADING_TO_META", "META_PROCESSING", "PUBLISHING", "PROCESSING", "PENDING"].includes(j.status)).length;
  const countPublished = jobs.filter((j) => j.status === "PUBLISHED").length;
  const countFailed = jobs.filter((j) => ["FAILED", "FAILED_RETRYABLE", "FAILED_PERMANENT", "FACEBOOK_RECONNECT_REQUIRED"].includes(j.status)).length;
  const hasExpiredTokens = pages.some((p) => p.tokenStatus === "Expired");
  const expiredPages = pages.filter((p) => p.tokenStatus === "Expired");

  // Compute URL matching warning on render
  let dashboardHostnameWarning: string | null = null;
  if (publicAppUrl) {
    try {
      const configUrl = new URL(publicAppUrl);
      if (typeof window !== "undefined") {
        const currentHost = window.location.host;
        const configHost = configUrl.host;
        if (configHost !== currentHost) {
          dashboardHostnameWarning = `Configured Public App URL (${configHost}) does not match current browser location (${currentHost}). OAuth redirects may fail unless accessed via the configured URL.`;
        }
      }
    } catch {
      dashboardHostnameWarning = "Configured Public App URL has an invalid URL format.";
    }
  }

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
            <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-600/30">
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
                  ? "bg-indigo-600 text-white shadow-sm border border-indigo-700 font-semibold"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 font-medium"
              }`}
            >
              Overview Dashboard
            </button>
            <button
              onClick={() => setActiveTab("publisher")}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium ${
                activeTab === "publisher"
                  ? "bg-indigo-600 text-white shadow-sm border border-indigo-700 font-semibold"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 font-medium"
              }`}
            >
              Bulk Media Publisher {tempJobsQueue.length > 0 && `(${tempJobsQueue.length})`}
            </button>
            <button
              onClick={() => setActiveTab("pages")}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium ${
                activeTab === "pages"
                  ? "bg-indigo-600 text-white shadow-sm border border-indigo-700 font-semibold"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 font-medium"
              }`}
            >
              Synced Pages ({countPages})
            </button>
            <button
              onClick={() => setActiveTab("logs")}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition font-medium ${
                activeTab === "logs"
                  ? "bg-indigo-600 text-white shadow-sm border border-indigo-700 font-semibold"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 font-medium"
              }`}
            >
              Security Audit Logs
            </button>
            <div className="h-[1px] bg-zinc-200 my-2"></div>
            <Link
              href="/settings/meta-configuration"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 font-medium"
            >
              Meta Configuration
            </Link>
            <Link
              href="/settings/storage"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 font-medium"
            >
              Google Drive Storage
            </Link>
            {currentUser.role === 'ADMIN' && (
              <Link
                href="/admin/users"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 font-medium"
              >
                User Management
              </Link>
            )}
          </nav>

          {/* Quick Simulation Options */}
          {currentUser.role === 'ADMIN' && process.env.NODE_ENV !== 'production' && (
            <div className="mt-auto pt-6 border-t border-zinc-200">
              <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-500 mb-3">Simulation Console</h3>
              <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-3.5 flex flex-col gap-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500">Trigger Expired Token</span>
                  <input
                    type="checkbox"
                    checked={simulateTokenExpiry}
                    onChange={handleToggleTokenExpiry}
                    className="rounded bg-white border-zinc-200 text-indigo-600 focus:ring-indigo-600 h-4 w-4"
                  />
                </div>
                <div className="flex flex-col gap-1 text-xs">
                  <span className="text-zinc-500 font-medium">Scenario</span>
                  <select
                    value={simulationScenario}
                    onChange={(e) => setSimulationScenario(normalizeClientScenario(e.target.value))}
                    className="w-full bg-white border border-zinc-200 rounded px-2.5 py-1.5 text-[11px] text-zinc-700 focus:outline-none focus:border-indigo-600 font-sans"
                  >
                    <option value="SUCCESS">Success Scenario</option>
                    <option value="TEMPORARY_NETWORK_FAILURE">Network Failure (Retryable)</option>
                    <option value="META_PROCESSING_DELAY">Processing Delay (Retryable)</option>
                    <option value="META_RATE_LIMIT">Rate Limit (Retryable)</option>
                    <option value="INVALID_MEDIA_FORMAT">Invalid Video Format (Perm)</option>
                    <option value="REVOKED_FACEBOOK_TOKEN">Revoked OAuth Token (Reconnect)</option>
                    <option value="MISSING_FACEBOOK_PERMISSION">Missing Page Permission (Perm)</option>
                  </select>
                </div>
                <button
                  onClick={handleSimulateQueueWorker}
                  disabled={simulatingPublish}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-200 disabled:text-zinc-400 font-semibold text-xs text-white py-2 px-3 rounded transition shadow-md shadow-indigo-600/10 flex items-center justify-center gap-1.5"
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
          )}

          {/* Profile & Logout Panel */}
          <div className={`border-t border-zinc-200 pt-4 flex flex-col gap-3 ${currentUser.role === 'ADMIN' && process.env.NODE_ENV !== 'production' ? 'mt-6' : 'mt-auto'}`}>
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-zinc-900 truncate">{currentUser.name}</span>
              <span className="text-[10px] text-zinc-500 truncate mt-0.5">{currentUser.email}</span>
              <span className="text-[9px] text-indigo-700 font-mono tracking-wider uppercase mt-1 px-1.5 py-0.5 bg-indigo-50 border border-indigo-200 rounded w-fit">{currentUser.role}</span>
            </div>
            <button
              onClick={handleLogout}
              className="w-full text-center flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 hover:border-rose-300 text-rose-800 hover:text-rose-900 text-xs font-semibold transition"
            >
              Logout
            </button>
          </div>
        </aside>

        {/* Content Panel */}
        <main className="flex-1 flex flex-col bg-zinc-50">

          {/* Header */}
          <header className="h-16 border-b border-zinc-200 px-8 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-zinc-900 tracking-tight capitalize">
                {activeTab === "dashboard" ? "Dashboard Overview" : activeTab}
              </h2>
              <span className="text-xs bg-white text-zinc-600 px-2 py-0.5 rounded font-mono border border-zinc-200">
                {kolkataOffsetStr}
              </span>
            </div>

            <div className="flex items-center gap-4 text-xs font-mono text-zinc-500">
              <span>Timezone: Asia/Kolkata</span>
              <span className="text-zinc-300">|</span>
              <span>Local System Time: {SYSTEM_TIME_STR}</span>
            </div>
          </header>

          {/* Main workspace container */}
          <div className="p-8 overflow-y-auto max-w-7xl w-full mx-auto flex-1">

            {/* System Warnings Panel */}
            <div className="mb-6 space-y-3">
              {(isConfigured === false || !facebookAppId) && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs text-rose-800 font-medium leading-relaxed flex items-start gap-3 shadow-sm">
                  <svg className="h-5 w-5 text-rose-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div>
                    <span className="font-bold">Meta Configuration Incomplete:</span> The Meta Configuration is missing or incomplete{facebookAppId ? ` (App ID: ${facebookAppId})` : ""}. Please go to <Link href="/settings/meta-configuration" className="underline text-rose-750 hover:text-rose-800 font-semibold">Meta Configuration</Link> settings to complete it.
                  </div>
                </div>
              )}

              {publicAppUrl && publicAppUrl.includes('trycloudflare.com') && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800 font-medium leading-relaxed flex items-start gap-3 shadow-sm">
                  <svg className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div>
                    <span className="font-bold">Temporary Quick-Tunnel Warning:</span> The application is using a temporary <code className="bg-zinc-100 text-zinc-800 px-1 py-0.5 rounded text-[10px]">trycloudflare.com</code> tunnel. Please update to a permanent custom domain under <Link href="/settings/meta-configuration" className="underline text-amber-700 hover:text-amber-800 font-semibold">Meta Configuration</Link> for production use.
                  </div>
                </div>
              )}

              {dashboardHostnameWarning && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800 font-medium leading-relaxed flex items-start gap-3 shadow-sm">
                  <svg className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div>
                    <span className="font-bold">Hostname Mismatch:</span> {dashboardHostnameWarning}
                  </div>
                </div>
              )}
            </div>

            {/* STATS METRIC GRID */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
              <div className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition">
                <span className="text-xs font-mono text-zinc-500">Connected Pages</span>
                <h4 className="text-3xl font-extrabold text-zinc-900 mt-1.5">{countPages}</h4>
              </div>
              <div className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition">
                <span className="text-xs font-mono text-zinc-500">Scheduled Jobs</span>
                <h4 className="text-3xl font-extrabold text-indigo-600 mt-1.5">{countScheduled}</h4>
              </div>
              <div className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition">
                <span className="text-xs font-mono text-zinc-500">Publishing Jobs</span>
                <h4 className="text-3xl font-extrabold text-amber-600 mt-1.5 flex items-center gap-2">
                  {countPublishing}
                  {countPublishing > 0 && <span className="h-2 w-2 rounded-full bg-amber-500 animate-ping"></span>}
                </h4>
              </div>
              <div className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition">
                <span className="text-xs font-mono text-zinc-500">Published Jobs</span>
                <h4 className="text-3xl font-extrabold text-emerald-600 mt-1.5">{countPublished}</h4>
              </div>
              <div className="bg-white border border-zinc-200 rounded-xl p-5 hover:border-zinc-300 transition">
                <span className="text-xs font-mono text-zinc-500">Failed Jobs</span>
                <h4 className="text-3xl font-extrabold text-rose-600 mt-1.5">{countFailed}</h4>
              </div>
            </div>

            {/* TAB CONTAINER CONTENT */}

            {/* 1. OVERVIEW DASHBOARD TAB */}
            {activeTab === "dashboard" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* Active Publishing Queue */}
                <div className="lg:col-span-2 flex flex-col gap-6">
                  <div className="bg-white border border-zinc-200 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-base font-bold text-zinc-900">Active Scheduled Jobs</h3>
                      <span className="text-xs text-zinc-500 font-mono">Times displayed in Asia/Kolkata</span>
                    </div>

                    {jobs.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500 border border-dashed border-zinc-200 rounded-lg">
                        No media loaded. Open the &quot;Bulk Media Publisher&quot; to schedule files.
                      </div>
                    ) : (
                      <div>
                        {/* Filters Toolbar */}
                        <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 mb-5 flex flex-wrap gap-4 items-end text-xs">
                          <div className="flex-1 min-w-[180px]">
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1 font-bold">Search Filename/Title</label>
                            <input
                              type="text"
                              value={filterFilename}
                              onChange={(e) => setFilterFilename(e.target.value)}
                              placeholder="Search..."
                              className="w-full bg-white border border-zinc-200 rounded-lg py-1.5 px-3 text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none focus:border-indigo-600"
                            />
                          </div>
                          <div className="w-full sm:w-44">
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1 font-bold">Page</label>
                            <select
                              value={filterPageId}
                              onChange={(e) => setFilterPageId(e.target.value)}
                              className="w-full bg-white border border-zinc-200 rounded-lg py-1.5 px-3.5 text-xs text-zinc-900 focus:outline-none"
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
                              className="w-full bg-white border border-zinc-200 rounded-lg py-1.5 px-3.5 text-xs text-zinc-900 focus:outline-none"
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
                              className="w-full bg-white border border-zinc-200 rounded-lg py-1.5 px-3 text-xs text-zinc-900 focus:outline-none"
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
                              className="bg-white hover:bg-zinc-50 text-zinc-700 font-semibold py-1.5 px-3 rounded-lg text-xs transition border border-zinc-300"
                            >
                              Clear
                            </button>
                          )}
                        </div>

                        {filteredJobs.length === 0 ? (
                          <div className="text-center py-10 text-zinc-500 bg-zinc-50 border border-dashed border-zinc-200 rounded-xl text-xs">
                            No scheduled jobs match the active filters.
                          </div>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm border-collapse">
                              <thead>
                                <tr className="border-b border-zinc-200 text-zinc-500 font-mono text-xs uppercase">
                                  <th className="pb-3 pr-4">File / Content Type</th>
                                  <th className="pb-3 px-4">Target Page</th>
                                  <th className="pb-3 px-4">Publish Date/Time (Kolkata)</th>
                                  <th className="pb-3 px-4">Status</th>
                                  <th className="pb-3 pl-4 text-right">Actions</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-zinc-200">
                                {filteredJobs.map((job) => {
                                  const targetPage = pages.find((p) => p.id === job.pageId);
                                  return (
                                    <tr key={job.id} className="hover:bg-zinc-50/50 transition">
                                      <td className="py-4 pr-4">
                                        <div className="font-medium text-zinc-900 max-w-[180px] truncate">{job.fileName}</div>
                                        <div className="flex items-center gap-1.5 mt-0.5">
                                          <span className="text-xs text-zinc-500">{job.fileSize}</span>
                                          <span className="text-[10px] text-zinc-300">•</span>
                                          <span className="text-[10px] font-semibold text-indigo-600 font-mono tracking-wider">
                                            {job.contentType === "PHOTO" ? "Facebook Photo" : job.contentType === "REEL" ? "Facebook Reel" : "Facebook Video"}
                                          </span>
                                        </div>
                                      </td>
                                      <td className="py-4 px-4 text-zinc-700 font-medium">
                                        {job.pageName || targetPage?.name || "Unassigned"}
                                      </td>
                                      <td className="py-4 px-4 font-mono text-xs">
                                        <div className="text-zinc-700">{formatDateTime(job.scheduledTimeKolkata)}</div>
                                        <div className="text-[10px] text-zinc-500 mt-0.5">UTC: {formatDateTime(job.scheduledTimeUTC)}Z</div>
                                      </td>
                                      <td className="py-4 px-4">
                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getStatusBadge(job.status)}`}>
                                          {getStatusLabel(job.status)}
                                        </span>
                                        {countdownJobs[job.id] !== undefined && (
                                          <div className="text-[10px] text-amber-600 font-mono mt-1 flex items-center gap-1">
                                            <span className="h-1 w-1 rounded-full bg-amber-600 animate-ping"></span>
                                            Retrying in {countdownJobs[job.id]}s...
                                          </div>
                                        )}
                                      </td>
                                      <td className="py-4 pl-4 text-right">
                                        {simulatingJobId === job.id ? (
                                          <div className="flex justify-end items-center gap-1.5 text-xs text-indigo-600 font-medium">
                                            <span className="animate-spin h-3.5 w-3.5 border-2 border-indigo-600 border-t-transparent rounded-full"></span>
                                            Running...
                                          </div>
                                        ) : (
                                          <div className="flex justify-end gap-1">
                                            {(["DRAFT", "MEDIA_UPLOADED", "SCHEDULED", "FAILED_RETRYABLE"].includes(job.status) ||
                                              (job.status === "PREPARING" && !job.providerReference && !job.providerProcessingId)) && (
                                              <button
                                                onClick={() => handleCancelJob(job.id)}
                                                className="text-zinc-600 hover:text-amber-800 transition px-2 py-1 rounded hover:bg-amber-50 text-xs font-semibold"
                                              >
                                                Cancel
                                              </button>
                                            )}
                                            {(job.status === "FAILED_RETRYABLE" || job.status === "FACEBOOK_RECONNECT_REQUIRED") && (
                                              <button
                                                onClick={() => handleRetryJobManual(job.id)}
                                                className="text-indigo-600 hover:text-indigo-800 transition px-2 py-1 rounded hover:bg-indigo-50 text-xs font-semibold"
                                              >
                                                Retry
                                              </button>
                                            )}
                                            <button
                                              onClick={() => setSelectedHistoryJob(job)}
                                              className="text-zinc-600 hover:text-zinc-900 transition px-2 py-1 rounded hover:bg-zinc-100 text-xs font-semibold"
                                            >
                                              History
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
                  <div className="bg-white border border-zinc-200 rounded-xl p-6">
                    <h3 className="text-base font-bold text-zinc-900 mb-4">Job Diagnostics Inspector</h3>
                    <div className="space-y-4">
                      {jobs.map((job) => {
                        const isFinished = job.status === "PUBLISHED" || job.status === "FAILED_PERMANENT" || job.status === "FAILED_RETRYABLE" || job.status === "FACEBOOK_RECONNECT_REQUIRED" || job.status === "CANCELLED";
                        if (isFinished) {
                          const isFailed = job.status !== "PUBLISHED";
                          return (
                            <div key={job.id} className={`p-4 rounded-lg border text-xs font-mono ${
                              isFailed ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"
                            }`}>
                              <div className="flex items-center justify-between mb-2">
                                <span className={`font-bold uppercase ${isFailed ? "text-rose-700" : "text-emerald-700"}`}>
                                  {getStatusLabel(job.status)} - ID: {job.id}
                                </span>
                                <span className="text-zinc-500">{job.fileName}</span>
                              </div>
                              {job.status === "PUBLISHED" && (
                                <p className="text-zinc-700">
                                  ✓ Meta Post ID Link: <a href="#" className="underline text-indigo-600" onClick={(e) => e.preventDefault()}>fb.com/{job.metaPostId}</a>
                                </p>
                              )}
                              {isFailed && (
                                <p className="text-rose-700 whitespace-pre-wrap">
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
                  <div className="bg-white border border-zinc-200 rounded-xl p-6 flex flex-col flex-1 h-full">
                    <h3 className="text-base font-bold text-zinc-900 mb-2">Worker Simulation Log</h3>
                    <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
                      Watch background steps execute, including token decryption and mock media publishing updates.
                    </p>

                    <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-4 font-mono text-[11px] leading-relaxed text-zinc-700 flex-1 min-h-[300px] overflow-y-auto max-h-[450px]">
                      {simulationLog.length === 0 ? (
                        <div className="text-zinc-500 italic h-full flex items-center justify-center">
                          Awaiting Worker triggering...
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {simulationLog.map((logLine, idx) => (
                            <div key={idx} className={
                              logLine.includes("ERROR")
                                ? "text-rose-600 font-semibold"
                                : logLine.includes("SUCCESS") || logLine.includes("Success")
                                ? "text-emerald-600 font-semibold"
                                : logLine.includes("WARNING")
                                ? "text-amber-600"
                                : "text-zinc-700"
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
                  <div className="lg:col-span-2 bg-white border border-zinc-200 rounded-xl p-6 flex flex-col justify-between">
                    <div>
                      <h3 className="text-base font-bold text-zinc-900 mb-2">Bulk Media Upload Workspace (Local Direct-to-App)</h3>
                      <p className="text-xs text-zinc-500 mb-5 leading-relaxed">
                        Select multiple MP4/MOV videos or JPG/JPEG/PNG/WebP images. The selected Facebook Page is assigned to every new file.
                      </p>

                      <div className="mb-5 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                          <div className="flex-1">
                            <label
                              htmlFor="publisher-default-page"
                              className="mb-2 block text-[10px] font-mono font-bold uppercase tracking-wider text-indigo-800"
                            >
                              Default Facebook Page for New Uploads
                            </label>
                            <select
                              id="publisher-default-page"
                              value={bulkPageId || ""}
                              onChange={(e) => {
                                setBulkPageId(e.target.value);
                                setFileUploadError(null);
                              }}
                              disabled={pages.length === 0}
                              className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2.5 text-xs font-semibold text-zinc-900 focus:border-indigo-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
                            >
                              <option value="">Select a page before uploading...</option>
                              {pages.map((page) => (
                                <option key={page.id} value={page.id}>
                                  {page.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="max-w-sm text-[10px] leading-4 text-indigo-800">
                            Every file selected next inherits this page automatically. Existing cards remain unchanged unless you use Apply Page to All.
                          </div>
                        </div>
                      </div>

                      <div
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        className={`border-2 border-dashed rounded-xl py-10 px-8 text-center relative group transition ${
                          bulkPageId && pages.some((page) => page.id === bulkPageId)
                            ? "border-zinc-300 hover:border-zinc-400 bg-zinc-50 cursor-pointer"
                            : "border-amber-300 bg-amber-50 cursor-not-allowed"
                        }`}
                      >
                        <svg className="h-10 w-10 text-zinc-400 group-hover:text-zinc-500 mx-auto mb-3 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        <span className="block text-sm text-zinc-750 font-semibold mb-1 group-hover:text-zinc-900 transition">
                          {bulkPageId && pages.some((page) => page.id === bulkPageId)
                            ? "Drag & Drop Videos or Images Here"
                            : "Select a Facebook Page Above to Enable Uploads"}
                        </span>
                        <span className="block text-xs text-zinc-500 font-mono">
                          MP4/MOV videos and JPG/JPEG/PNG/WebP images are detected automatically.
                        </span>

                        <div className="mt-5 flex flex-col sm:flex-row items-center justify-center gap-3">
                          <label className={`min-w-40 rounded-lg px-5 py-2.5 text-xs font-bold transition ${
                            bulkPageId && pages.some((page) => page.id === bulkPageId)
                              ? "cursor-pointer bg-indigo-600 text-white hover:bg-indigo-500"
                              : "cursor-not-allowed bg-zinc-200 text-zinc-500"
                          }`}>
                            Upload Videos
                            <input
                              type="file"
                              multiple
                              accept={SUPPORTED_VIDEO_ACCEPT}
                              onChange={triggerPickerChange}
                              disabled={!bulkPageId || !pages.some((page) => page.id === bulkPageId)}
                              className="hidden"
                            />
                          </label>
                          <label className={`min-w-40 rounded-lg px-5 py-2.5 text-xs font-bold transition ${
                            bulkPageId && pages.some((page) => page.id === bulkPageId)
                              ? "cursor-pointer bg-emerald-600 text-white hover:bg-emerald-500"
                              : "cursor-not-allowed bg-zinc-200 text-zinc-500"
                          }`}>
                            Upload Images
                            <input
                              type="file"
                              multiple
                              accept={SUPPORTED_IMAGE_ACCEPT}
                              onChange={triggerPickerChange}
                              disabled={!bulkPageId || !pages.some((page) => page.id === bulkPageId)}
                              className="hidden"
                            />
                          </label>
                        </div>
                      </div>

                      {fileUploadError && (
                        <div className="mt-3 text-xs text-rose-800 font-semibold bg-rose-50 border border-rose-200 rounded-lg p-2 flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-600"></span>
                          {fileUploadError}
                        </div>
                      )}

                      {queueItems.length > 0 && (
                        <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-4 mt-5 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3 items-center text-center">
                          <div className="text-xs">
                            <span className="block text-zinc-500 font-mono uppercase tracking-wider text-[9px]">Total</span>
                            <span className="text-sm font-extrabold text-zinc-900">{queueItems.length}</span>
                          </div>
                          <div className="text-xs">
                            <span className="block text-zinc-500 font-mono uppercase tracking-wider text-[9px]">Queued</span>
                            <span className="text-sm font-extrabold text-zinc-750">{queueItems.filter((i) => i.status === 'QUEUED').length}</span>
                          </div>
                          <div className="text-xs">
                            <span className="block text-zinc-500 font-mono uppercase tracking-wider text-[9px]">Uploading</span>
                            <span className="text-sm font-extrabold text-indigo-600 animate-pulse">{queueItems.filter((i) => ['INITIATING', 'UPLOADING', 'RECONCILING', 'RETRY_WAIT'].includes(i.status)).length}</span>
                          </div>
                          <div className="text-xs">
                            <span className="block text-zinc-500 font-mono uppercase tracking-wider text-[9px]">Validating</span>
                            <span className="text-sm font-extrabold text-amber-600 animate-pulse">{queueItems.filter((i) => ['COMPLETING', 'VALIDATING'].includes(i.status)).length}</span>
                          </div>
                          <div className="text-xs">
                            <span className="block text-zinc-500 font-mono uppercase tracking-wider text-[9px]">Completed</span>
                            <span className="text-sm font-extrabold text-emerald-600">{queueItems.filter((i) => i.status === 'VALIDATED').length}</span>
                          </div>
                          <div className="text-xs">
                            <span className="block text-zinc-500 font-mono uppercase tracking-wider text-[9px]">Failed</span>
                            <span className="text-sm font-extrabold text-rose-600">{queueItems.filter((i) => i.status === 'FAILED').length}</span>
                          </div>
                          <div className="text-xs col-span-2 sm:col-span-1 md:col-span-1 border-t sm:border-t-0 md:border-l border-zinc-200 pt-2 sm:pt-0 pl-0 sm:pl-2">
                            <span className="block text-zinc-500 font-mono uppercase tracking-wider text-[9px] mb-0.5">Concurrency</span>
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 border border-indigo-100 text-indigo-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-indigo-600 animate-ping"></span>
                              {queueItems.filter((i) => ['INITIATING', 'UPLOADING', 'RECONCILING', 'COMPLETING', 'VALIDATING'].includes(i.status)).length} of 2 active
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Configuration settings block */}
                    <div className="mt-6 pt-5 border-t border-zinc-200 flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-xs font-semibold text-zinc-900">Configure Max File Size Boundary</h4>
                        <p className="text-[10px] text-zinc-500">Validation flag applies instantly to files exceeding this threshold.</p>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <input
                          type="number"
                          value={maxFileSizeMB}
                          onChange={(e) => setMaxFileSizeMB(Number(e.target.value))}
                          className="w-24 bg-white border border-zinc-200 rounded-lg py-1.5 px-3 text-xs text-zinc-900 text-center focus:outline-none focus:border-indigo-600 font-mono font-bold"
                          min={1}
                        />
                        <span className="text-xs font-mono text-zinc-500 font-bold">MB</span>
                      </div>
                    </div>
                  </div>

                  {/* CSV Metadata Importer */}
                  <div className="bg-white border border-zinc-200 rounded-xl p-6 flex flex-col justify-between">
                    <div>
                      <h3 className="text-base font-bold text-zinc-900 mb-2">CSV Metadata Importer</h3>
                      <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
                        Import a CSV metadata table matching media targets by filename. Shows row-level errors for broken formatting or invalid references.
                      </p>

                      <div className="flex flex-col gap-3">
                        <button
                          onClick={handleDownloadCsvTemplate}
                          className="w-full bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-semibold py-2 px-3 border border-zinc-200 rounded-lg text-xs transition flex items-center justify-center gap-1.5"
                        >
                          Download CSV Template
                        </button>

                        <div className="relative w-full bg-white border border-zinc-200 hover:border-zinc-300 rounded-lg p-2.5 text-center text-xs font-semibold text-zinc-700 cursor-pointer transition">
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
                      <div className="mt-4 pt-4 border-t border-zinc-200 text-xs max-h-[160px] overflow-y-auto">
                        <div className="font-bold text-zinc-900 mb-1.5 uppercase font-mono tracking-wider text-[10px]">Import Summary:</div>
                        {csvSuccessCount > 0 && (
                          <div className="text-emerald-600 font-medium mb-1 flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                            Successfully matched & updated {csvSuccessCount} media items.
                          </div>
                        )}
                        {csvErrors.map((err, idx) => (
                          <div key={idx} className="text-rose-600 leading-relaxed pl-3 border-l border-rose-200 mb-1 font-mono text-[10px]">
                            {err}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* PHASE 7E BULK TITLES AND CAPTIONS */}
                {tempJobsQueue.length > 0 && (
                  <div className="bg-white border border-zinc-200 rounded-xl p-6">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <h3 className="text-base font-bold text-zinc-900">
                          Bulk Titles & Captions
                        </h3>
                        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-500">
                          Assign one title and caption to each upload card in order, or match CSV rows by filename. Unicode, emojis, and multilingual text are supported.
                        </p>
                      </div>
                      <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-wider text-indigo-800">
                        {tempJobsQueue.length} upload cards ready
                      </div>
                    </div>

                    <div className="mt-5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handleBulkMetadataSourceChange("paste")}
                        className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${
                          bulkMetadataSource === "paste"
                            ? "border-indigo-600 bg-indigo-600 text-white"
                            : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                        }`}
                      >
                        Paste / TXT Lists
                      </button>
                      <button
                        type="button"
                        onClick={() => handleBulkMetadataSourceChange("csv")}
                        className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${
                          bulkMetadataSource === "csv"
                            ? "border-indigo-600 bg-indigo-600 text-white"
                            : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                        }`}
                      >
                        CSV File
                      </button>
                    </div>

                    {bulkMetadataSource === "paste" ? (
                      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
                        <div>
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-600">
                              Titles — one non-empty line per card
                            </label>
                            <label className="relative cursor-pointer rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[10px] font-bold text-zinc-700 hover:bg-zinc-100">
                              Upload Titles TXT
                              <input
                                type="file"
                                accept=".txt,text/plain"
                                onChange={(event) => handleBulkMetadataTextFile(event, "title")}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                            </label>
                          </div>
                          <textarea
                            value={bulkTitlesText}
                            onChange={(event) => {
                              setBulkTitlesText(event.target.value);
                              setBulkMetadataSource("paste");
                              setBulkMetadataMatchMode("upload_order");
                              setBulkMetadataErrors([]);
                              clearBulkMetadataPreview();
                            }}
                            rows={9}
                            className="w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-3 text-xs leading-5 text-zinc-900 focus:border-indigo-600 focus:outline-none"
                            placeholder={"Title for upload 1\nTitle for upload 2\nTitle for upload 3"}
                          />
                        </div>

                        <div>
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-600">
                              Captions — one non-empty line per card
                            </label>
                            <label className="relative cursor-pointer rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-[10px] font-bold text-zinc-700 hover:bg-zinc-100">
                              Upload Captions TXT
                              <input
                                type="file"
                                accept=".txt,text/plain"
                                onChange={(event) => handleBulkMetadataTextFile(event, "caption")}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                            </label>
                          </div>
                          <textarea
                            value={bulkCaptionsText}
                            onChange={(event) => {
                              setBulkCaptionsText(event.target.value);
                              setBulkMetadataSource("paste");
                              setBulkMetadataMatchMode("upload_order");
                              setBulkMetadataErrors([]);
                              clearBulkMetadataPreview();
                            }}
                            rows={9}
                            className="w-full resize-y rounded-xl border border-zinc-200 bg-white px-3 py-3 text-xs leading-5 text-zinc-900 focus:border-indigo-600 focus:outline-none"
                            placeholder={"Caption for upload 1\nCaption for upload 2\nCaption for upload 3"}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto_auto] lg:items-center">
                          <div>
                            <div className="text-xs font-bold text-zinc-900">
                              Upload a simple metadata CSV
                            </div>
                            <div className="mt-1 text-[10px] leading-4 text-zinc-500">
                              Headers may be title,caption or filename,title,caption. Filename matching is case-insensitive.
                            </div>
                            {bulkMetadataCsvFileName && (
                              <div className="mt-2 text-[10px] font-mono font-bold text-indigo-700">
                                Loaded: {bulkMetadataCsvFileName} ({bulkMetadataCsvRows.length} rows)
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={handleDownloadBulkMetadataCsvTemplate}
                            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-700 hover:bg-zinc-100"
                          >
                            Download Template
                          </button>
                          <label className="relative cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-center text-xs font-bold text-white hover:bg-indigo-500">
                            Upload CSV
                            <input
                              type="file"
                              accept=".csv,text/csv"
                              onChange={handleBulkMetadataCsvFile}
                              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                            />
                          </label>
                        </div>
                      </div>
                    )}

                    <div className="mt-5 grid grid-cols-1 gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 md:grid-cols-2 lg:grid-cols-[1fr_1.3fr_auto] lg:items-end">
                      <div>
                        <label className="mb-2 block text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-600">
                          Assignment Method
                        </label>
                        <select
                          value={bulkMetadataMatchMode}
                          onChange={(event) => {
                            setBulkMetadataMatchMode(event.target.value as BulkMetadataMatchMode);
                            setBulkMetadataErrors([]);
                            clearBulkMetadataPreview();
                          }}
                          disabled={bulkMetadataSource === "paste"}
                          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 focus:border-indigo-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500"
                        >
                          <option value="upload_order">Assign in upload order</option>
                          <option value="filename">Match by filename</option>
                        </select>
                      </div>

                      <label className="flex min-h-10 cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2">
                        <input
                          type="checkbox"
                          checked={bulkMetadataOverwriteExisting}
                          onChange={(event) => {
                            setBulkMetadataOverwriteExisting(event.target.checked);
                            setBulkMetadataErrors([]);
                            clearBulkMetadataPreview();
                          }}
                          className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                        />
                        <span>
                          <span className="block text-xs font-bold text-zinc-900">
                            Overwrite existing title and caption
                          </span>
                          <span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">
                            Off protects manual or AI metadata. Filename placeholder titles are still replaceable.
                          </span>
                        </span>
                      </label>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handlePreviewBulkMetadata}
                          className="rounded-lg bg-zinc-900 px-4 py-2.5 text-xs font-bold text-white hover:bg-zinc-800"
                        >
                          Preview Assignment
                        </button>
                        <button
                          type="button"
                          onClick={handleApplyBulkMetadata}
                          disabled={!bulkMetadataPreview || bulkMetadataPreview.assignments.length === 0}
                          className="rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300"
                        >
                          Apply to Cards
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleUndoBulkMetadata}
                        disabled={!bulkMetadataUndo || bulkMetadataUndo.length === 0}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300"
                      >
                        Undo Last Assignment
                      </button>
                      <button
                        type="button"
                        onClick={handleResetBulkMetadataInputs}
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-700 hover:bg-zinc-50"
                      >
                        Clear Input
                      </button>
                      {bulkMetadataLastResult && (
                        <span className="text-xs font-semibold text-emerald-700">
                          {bulkMetadataLastResult}
                        </span>
                      )}
                    </div>

                    {bulkMetadataErrors.length > 0 && (
                      <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3">
                        {bulkMetadataErrors.slice(0, 12).map((error, index) => (
                          <div key={`${error}-${index}`} className="text-[10px] leading-5 text-rose-700">
                            {error}
                          </div>
                        ))}
                        {bulkMetadataErrors.length > 12 && (
                          <div className="mt-1 text-[10px] font-bold text-rose-800">
                            Plus {bulkMetadataErrors.length - 12} more errors.
                          </div>
                        )}
                      </div>
                    )}

                    {bulkMetadataPreview && (
                      <div className="mt-5 overflow-hidden rounded-xl border border-zinc-200">
                        <div className="grid grid-cols-2 gap-px bg-zinc-200 sm:grid-cols-4 lg:grid-cols-8">
                          {[
                            ["Cards", bulkMetadataPreview.targetCount],
                            ["Rows", bulkMetadataPreview.rowCount],
                            ["Will Update", bulkMetadataPreview.willUpdate],
                            ["Protected", bulkMetadataPreview.skippedExisting],
                            ["Invalid", bulkMetadataPreview.invalidRows],
                            ["Unmatched", bulkMetadataPreview.unmatchedRows],
                            ["Unused", bulkMetadataPreview.unusedRows],
                            ["No Row", bulkMetadataPreview.unassignedTargets],
                          ].map(([label, value]) => (
                            <div key={String(label)} className="bg-white p-3 text-center">
                              <div className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-500">
                                {label}
                              </div>
                              <div className="mt-1 text-base font-extrabold text-zinc-900">
                                {value}
                              </div>
                            </div>
                          ))}
                        </div>

                        <div className="max-h-72 overflow-auto bg-white">
                          <table className="w-full min-w-[760px] text-left text-[10px]">
                            <thead className="sticky top-0 bg-zinc-50 text-zinc-500">
                              <tr>
                                <th className="px-3 py-2 font-mono uppercase">Row</th>
                                <th className="px-3 py-2 font-mono uppercase">Upload Card</th>
                                <th className="px-3 py-2 font-mono uppercase">Title</th>
                                <th className="px-3 py-2 font-mono uppercase">Caption</th>
                                <th className="px-3 py-2 font-mono uppercase">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bulkMetadataPreview.previewRows.slice(0, 50).map((row, index) => (
                                <tr key={`${row.sourceRow}-${row.jobId || index}`} className="border-t border-zinc-100 align-top">
                                  <td className="px-3 py-2 font-mono text-zinc-500">{row.sourceRow}</td>
                                  <td className="max-w-48 truncate px-3 py-2 font-semibold text-zinc-800">{row.fileName || "—"}</td>
                                  <td className="max-w-64 truncate px-3 py-2 text-zinc-700">{row.title || "—"}</td>
                                  <td className="max-w-72 truncate px-3 py-2 text-zinc-700">{row.caption || "—"}</td>
                                  <td className={`px-3 py-2 font-semibold ${
                                    row.status === "ready"
                                      ? "text-emerald-700"
                                      : row.status === "skipped"
                                        ? "text-amber-700"
                                        : "text-rose-700"
                                  }`}>
                                    {row.message}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {bulkMetadataPreview.previewRows.length > 50 && (
                          <div className="border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-[10px] font-semibold text-zinc-600">
                            Showing the first 50 of {bulkMetadataPreview.previewRows.length} preview rows.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* BULK ACTIONS TOOLBAR */}
                {tempJobsQueue.length > 0 && (
                  <div className="bg-white border border-zinc-200 rounded-xl p-6">
                    <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-900 mb-4 font-bold">Bulk Action Controller</h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 items-end text-xs">
                      {/* Bulk Page Selector */}
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Select Facebook Page</label>
                        <div className="flex gap-2">
                          <select
                            value={bulkPageId || ""}
                            onChange={(e) => setBulkPageId(e.target.value)}
                            className="flex-1 bg-white border border-zinc-200 rounded-lg py-2 px-2 text-xs text-zinc-900 focus:outline-none"
                          >
                            <option value="">Select a page...</option>
                            {pages.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                          <button
                            onClick={handleApplyPageToAll}
                            disabled={!bulkPageId}
                            className="bg-indigo-600 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300 text-white font-bold px-3 rounded transition text-[10px]"
                          >
                            Apply All
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
                            className="flex-1 bg-white border border-zinc-200 rounded-lg py-2 px-2 text-xs text-zinc-900 focus:outline-none"
                          >
                            <option value="VIDEO">Facebook Video</option>
                            <option value="REEL">Facebook Reel</option>
                          </select>
                          <button
                            onClick={handleApplyContentTypeToAll}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-3 rounded transition text-[10px]"
                          >
                            Apply
                          </button>
                        </div>
                      </div>

                      {/* Bulk Caption Editor */}
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Configure Caption</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={bulkCaption}
                            onChange={(e) => setBulkCaption(e.target.value)}
                            className="flex-1 bg-white border border-zinc-200 rounded-lg py-2 px-2.5 text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none"
                            placeholder="All caption text"
                          />
                          <button
                            onClick={handleApplyCaptionToAll}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-3 rounded transition text-[10px]"
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
                            className="flex-1 bg-white border border-zinc-200 rounded-lg py-2 px-2.5 text-xs text-zinc-900 placeholder-zinc-400 focus:outline-none"
                            placeholder="e.g. #NewPost #Meta"
                          />
                          <button
                            onClick={handleAppendHashtagsToAll}
                            className="bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-bold px-3.5 border border-zinc-200 rounded transition text-[10px]"
                          >
                            Append
                          </button>
                          <button
                            onClick={handleReplaceHashtagsToAll}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-3.5 rounded transition text-[10px]"
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
                  <div className="bg-white border border-zinc-200 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4 border-b border-zinc-200 pb-3">
                      <h3 className="text-xs font-mono uppercase tracking-wider text-zinc-900 font-bold">Scheduling Options</h3>
                      <div className="flex gap-3 text-xs">
                        <button
                          onClick={() => setSchedulingMode("individual")}
                          className={`px-3 py-1 rounded-full font-semibold transition ${
                            schedulingMode === "individual" ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:text-zinc-900"
                          }`}
                        >
                          Individual Settings
                        </button>
                        <button
                          onClick={() => setSchedulingMode("interval")}
                          className={`px-3 py-1 rounded-full font-semibold transition ${
                            schedulingMode === "interval" ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:text-zinc-900"
                          }`}
                        >
                          Fixed Intervals
                        </button>
                        <button
                          onClick={() => setSchedulingMode("slots")}
                          className={`px-3 py-1 rounded-full font-semibold transition ${
                            schedulingMode === "slots" ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:text-zinc-900"
                          }`}
                        >
                          Daily Time Slots
                        </button>
                        <button
                          onClick={() => setSchedulingMode("random_windows")}
                          className={`px-3 py-1 rounded-full font-semibold transition ${
                            schedulingMode === "random_windows" ? "bg-indigo-50 text-indigo-700" : "text-zinc-500 hover:text-zinc-900"
                          }`}
                        >
                          Random Time Windows
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
                            className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900 focus:outline-none focus:border-indigo-600"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Post Spacing Frequency</label>
                          <select
                            value={intervalHours}
                            onChange={(e) => setIntervalHours(parseInt(e.target.value))}
                            className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900 focus:outline-none focus:border-indigo-600"
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
                          className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-lg text-xs transition"
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
                              className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900 focus:outline-none focus:border-indigo-600"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Configure Time Slot (24h HH:MM)</label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={newSlotInput}
                                onChange={(e) => setNewSlotInput(e.target.value)}
                                className="flex-1 bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900 placeholder-zinc-400"
                                placeholder="e.g. 14:30"
                              />
                              <button
                                onClick={handleAddSlot}
                                className="bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-bold px-3 border border-zinc-200 rounded-lg transition"
                              >
                                Add
                              </button>
                            </div>
                          </div>
                          <button
                            onClick={handleApplySchedulingMode}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 rounded-lg text-xs transition"
                          >
                            Distribute over Daily Slots
                          </button>
                        </div>

                        {/* List of active daily time slots */}
                        <div className="flex flex-wrap gap-2.5 text-xs">
                          {dailyTimeSlots.map((slot, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-zinc-100 border border-zinc-200 font-mono text-xs font-bold text-zinc-800"
                            >
                              {slot}
                              <button
                                onClick={() => handleRemoveSlot(idx)}
                                className="text-zinc-500 hover:text-rose-500 font-bold ml-1.5"
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

                    {schedulingMode === "random_windows" && (
                      <div className="space-y-5">
                        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-xs text-indigo-800">
                          Generate each publishing time once inside the selected windows, review the exact result, then apply it. Applied times are saved with the upload cards and remain unchanged after refresh or worker restart.
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Start Date (Kolkata)</label>
                            <input
                              type="date"
                              value={randomWindowsStartDate}
                              onChange={(event) => {
                                setRandomWindowsStartDate(event.target.value);
                                invalidateRandomSchedulePreview();
                              }}
                              className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900 focus:outline-none focus:border-indigo-600"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Videos per Window</label>
                            <input
                              type="number"
                              min={1}
                              max={20}
                              value={randomPostsPerWindow}
                              onChange={(event) => {
                                setRandomPostsPerWindow(Number(event.target.value));
                                invalidateRandomSchedulePreview();
                              }}
                              className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900 focus:outline-none focus:border-indigo-600"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">Minimum Gap (Minutes)</label>
                            <input
                              type="number"
                              min={1}
                              max={720}
                              value={randomMinimumGapMinutes}
                              onChange={(event) => {
                                setRandomMinimumGapMinutes(Number(event.target.value));
                                invalidateRandomSchedulePreview();
                              }}
                              className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900 focus:outline-none focus:border-indigo-600"
                            />
                          </div>
                          <label className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs text-zinc-700">
                            <input
                              type="checkbox"
                              checked={randomOverwriteExisting}
                              onChange={(event) => {
                                setRandomOverwriteExisting(event.target.checked);
                                invalidateRandomSchedulePreview();
                              }}
                            />
                            Overwrite existing card times
                          </label>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">New Window Start</label>
                            <input
                              type="time"
                              value={newRandomWindowStart}
                              onChange={(event) => setNewRandomWindowStart(event.target.value)}
                              className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-2">New Window End</label>
                            <input
                              type="time"
                              value={newRandomWindowEnd}
                              onChange={(event) => setNewRandomWindowEnd(event.target.value)}
                              className="w-full bg-white border border-zinc-200 rounded-lg py-2.5 px-3.5 text-xs text-zinc-900"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={handleAddRandomTimeWindow}
                            className="rounded-lg border border-zinc-200 bg-zinc-100 px-4 py-2.5 text-xs font-bold text-zinc-700 hover:bg-zinc-200"
                          >
                            Add Window
                          </button>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {randomTimeWindows.map((window, index) => (
                            <span
                              key={window.id}
                              className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 font-mono text-xs font-bold text-indigo-800"
                            >
                              Window {index + 1}: {window.startTime}–{window.endTime}
                              <button
                                type="button"
                                onClick={() => handleRemoveRandomTimeWindow(window.id)}
                                className="text-indigo-500 hover:text-rose-600"
                                aria-label={`Remove window ${index + 1}`}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          {randomTimeWindows.length === 0 && (
                            <span className="text-xs italic text-rose-600">Add at least one time window.</span>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-3">
                          <button
                            type="button"
                            onClick={handleGenerateRandomSchedulePreview}
                            className="rounded-lg bg-zinc-800 px-4 py-2.5 text-xs font-bold text-white hover:bg-zinc-700"
                          >
                            {randomSchedulePreview ? "Regenerate Exact Preview" : "Generate Exact Preview"}
                          </button>
                          <button
                            type="button"
                            onClick={handleApplyRandomSchedulePreview}
                            disabled={!randomSchedulePreview || randomSchedulePreview.errors.length > 0 || randomSchedulePreview.items.length === 0}
                            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500"
                          >
                            Apply Preview to Cards
                          </button>
                          <button
                            type="button"
                            onClick={handleUndoRandomSchedule}
                            disabled={!randomScheduleUndo || randomScheduleUndo.length === 0}
                            className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-xs font-bold text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:text-zinc-300"
                          >
                            Undo Last Assignment
                          </button>
                        </div>

                        {randomScheduleErrors.length > 0 && (
                          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                            {randomScheduleErrors.map((error) => (
                              <div key={error}>• {error}</div>
                            ))}
                          </div>
                        )}

                        {randomScheduleLastResult && (
                          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">
                            {randomScheduleLastResult}
                          </div>
                        )}

                        {randomSchedulePreview && randomSchedulePreview.errors.length === 0 && (
                          <div className="overflow-hidden rounded-lg border border-zinc-200">
                            <div className="flex flex-wrap justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-700">
                              <span>{randomSchedulePreview.items.length} cards will receive exact times.</span>
                              <span>{randomSchedulePreview.protectedCount} existing schedules protected.</span>
                              <span>{randomSchedulePreview.daysUsed} calendar days used.</span>
                            </div>
                            <div className="max-h-72 overflow-auto">
                              <table className="w-full text-left text-xs">
                                <thead className="sticky top-0 bg-white text-[10px] uppercase text-zinc-500">
                                  <tr>
                                    <th className="px-3 py-2">#</th>
                                    <th className="px-3 py-2">File</th>
                                    <th className="px-3 py-2">Window</th>
                                    <th className="px-3 py-2">Exact Kolkata Time</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {randomSchedulePreview.items.slice(0, 200).map((item, index) => (
                                    <tr key={item.jobId} className="border-t border-zinc-100">
                                      <td className="px-3 py-2 text-zinc-500">{index + 1}</td>
                                      <td className="max-w-[280px] truncate px-3 py-2 text-zinc-800" title={item.fileName}>{item.fileName}</td>
                                      <td className="px-3 py-2 font-mono text-indigo-700">{item.windowLabel}</td>
                                      <td className="px-3 py-2 font-mono text-zinc-800">{formatDateTime(item.scheduledTimeKolkata)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {randomSchedulePreview.items.length > 200 && (
                              <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-[10px] text-zinc-500">
                                Showing the first 200 of {randomSchedulePreview.items.length} assignments. All assignments will be applied.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* EDIT QUEUED BULK CARDS LIST */}
                <div className="bg-white border border-zinc-200 rounded-xl p-6">
                  <div className="flex items-center justify-between mb-6 border-b border-zinc-200 pb-4">
                    <div>
                      <h3 className="text-base font-bold text-zinc-900 mb-0.5">Publisher Upload Cards</h3>
                      <p className="text-xs text-zinc-500">Configure parameters for uploaded media awaiting scheduling confirmation.</p>
                    </div>
                    {tempJobsQueue.length > 0 && (
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => handleAnalyzeAllValidated(false)}
                            disabled={
                              isBulkGeminiAnalysisRunning ||
                              !tempJobsQueue.some(
                                (job) =>
                                  job.uploadValidated &&
                                  job.assetId &&
                                  job.geminiAnalysisStatus !== "complete" &&
                                  job.geminiAnalysisStatus !== "analyzing"
                              )
                            }
                            className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-300 disabled:text-zinc-500 disabled:cursor-not-allowed text-white font-bold text-xs py-2 px-4 rounded-lg transition"
                          >
                            {isBulkGeminiAnalysisRunning && bulkStatus
                              ? `Analyzing ${bulkStatus.completed + bulkStatus.failed} of ${bulkStatus.total}`
                              : "Generate All with AI"}
                          </button>
                          <button
                            onClick={() => handleAnalyzeAllValidated(true)}
                            disabled={
                              isBulkGeminiAnalysisRunning ||
                              !tempJobsQueue.some(
                                (job) =>
                                  job.uploadValidated &&
                                  job.assetId &&
                                  job.geminiAnalysisStatus !== "analyzing"
                              )
                            }
                            className="bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-300 disabled:text-zinc-500 disabled:cursor-not-allowed text-white font-bold text-xs py-2 px-4 rounded-lg transition"
                          >
                            Regenerate All with AI
                          </button>
                          <button
                            onClick={handleSaveTrigger}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs py-2 px-4 rounded-lg transition shadow-md shadow-emerald-600/10"
                          >
                            Confirm Scheduled Queue
                          </button>
                        </div>
                        {bulkStatus && (
                          <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-4 flex flex-wrap gap-6 items-center justify-between text-xs text-zinc-700">
                            <div className="flex gap-4">
                              <div><span className="font-bold text-zinc-900">Total:</span> {bulkStatus.total}</div>
                              <div><span className="font-bold text-zinc-900">Active:</span> {bulkStatus.active}</div>
                              <div><span className="font-bold text-zinc-900">Completed:</span> {bulkStatus.completed}</div>
                              <div><span className="font-bold text-zinc-900">Failed:</span> {bulkStatus.failed}</div>
                              {bulkStatus.cancelled > 0 && (
                                <div><span className="font-bold text-zinc-900">Cancelled:</span> {bulkStatus.cancelled}</div>
                              )}
                            </div>
                            {isBulkGeminiAnalysisRunning && (
                              <button
                                onClick={handleCancelBulkAnalysis}
                                className="bg-red-600 hover:bg-red-500 text-white font-bold py-1 px-3 rounded text-[10px] transition"
                              >
                                Cancel Bulk Analysis
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="space-y-6">
                    {tempJobsQueue.map((job) => {
                      const errors = getJobValidationErrors(job, tempJobsQueue);
                      return (
                        <div
                          key={job.id}
                          className={`bg-zinc-50 border rounded-xl p-6 relative transition ${
                            errors.length > 0 ? "border-rose-200" : "border-zinc-200"
                          }`}
                        >
                          <button
                            onClick={() => handleDeleteDraft(job.id)}
                            className="absolute top-4 right-4 text-xs text-rose-500 hover:underline transition"
                          >
                            Remove Media
                          </button>

                          {/* Validation Badges */}
                          {errors.length > 0 && (
                            <div className="mb-4 space-y-1.5">
                              {errors.map((err, idx) => (
                                <div key={idx} className="text-[10px] text-rose-800 font-semibold font-mono bg-rose-50 border border-rose-200 px-2 py-1 rounded">
                                  ⚠ Validation Error: {err}
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="flex flex-col lg:flex-row gap-6">

                            {/* File Preview & Thumbnail Capture Column */}
                            <div className="w-full lg:w-72 flex-shrink-0 flex flex-col gap-4">

                              {(() => {
                                const qItem = queueItems.find((q) => q.id === job.id);
                                return (
                                  <>
                                    <VideoUploader
                                      itemId={job.id}
                                      filename={job.fileName}
                                      size={job.fileSizeBytes}
                                      status={qItem ? qItem.status : 'QUEUED'}
                                      progressPercent={qItem ? qItem.progressPercent : 0}
                                      uploadedBytes={qItem ? qItem.uploadedBytes : 0}
                                      error={qItem?.error}
                                      metadata={qItem?.metadata}
                                      contentType={job.contentType}
                                      onStart={() => {
                                        if (qItem) {
                                          queueControllerRef.current?.processQueue();
                                        }
                                      }}
                                      onPause={() => queueControllerRef.current?.pauseUpload(job.id)}
                                      onResume={() => queueControllerRef.current?.resumeUpload(job.id)}
                                      onCancel={() => queueControllerRef.current?.cancelUpload(job.id)}
                                      onRetry={() => queueControllerRef.current?.retryUpload(job.id)}
                                      onReselectFile={(file) => {
                                        queueControllerRef.current?.reselectFile(job.id, file);
                                      }}
                                      onRemove={() => handleDeleteDraft(job.id)}
                                    />

                                    {/* Native media preview */}
                                    {job.localMediaUrl || job.localVideoUrl ? (
                                      <div className="aspect-video bg-black rounded-lg overflow-hidden border border-zinc-200 relative flex items-center justify-center mt-2">
                                        {job.contentType === "PHOTO" ? (
                                          <>
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                              src={job.localMediaUrl || job.localVideoUrl}
                                              alt={`Preview of ${job.fileName}`}
                                              className="h-full w-full object-contain"
                                            />
                                          </>
                                        ) : (
                                          <video
                                            src={job.localMediaUrl || job.localVideoUrl}
                                            className="h-full w-full object-contain"
                                            controls
                                          />
                                        )}
                                      </div>
                                    ) : (
                                      <div className="aspect-video bg-zinc-100 rounded-lg flex items-center justify-center border border-zinc-200 text-zinc-500 text-xs mt-2">
                                        {job.contentType === "PHOTO" ? "Image Preview Unavailable" : "Video Preview Unavailable"}
                                      </div>
                                    )}

                                    <div className="text-xs space-y-1.5 text-zinc-500 font-mono">
                                      <div className="truncate max-w-[280px]">Original Name: <span className="text-zinc-800">{job.fileName}</span></div>
                                      <div>Size: <span className="text-zinc-800">{job.fileSize}</span></div>
                                      {job.contentType !== "PHOTO" && (
                                        <div>Duration: <span className="text-zinc-800">{job.durationSeconds ? `${job.durationSeconds}s` : "Scanning..."}</span></div>
                                      )}
                                      <div>Media Type: <span className="text-indigo-600 font-semibold">{job.contentType === "PHOTO" ? "Image" : "Video"}</span></div>
                                      <div>Language: <span className="text-indigo-600 font-semibold">Any language + emoji</span></div>
                                    </div>
                                  </>
                                );
                              })()}

                              {/* Thumbnail Settings */}
                              {job.contentType !== "PHOTO" && (
                                <div className="border-t border-zinc-200 pt-3.5 space-y-2 text-xs">
                                <label className="block font-mono text-zinc-500 uppercase tracking-wider text-[10px]">Assign Thumbnail</label>

                                <div className="grid grid-cols-2 gap-2">
                                  <button
                                    onClick={() =>
                                      updateTempJobFields(job.id, {
                                        thumbnailMode: "auto",
                                        thumbnailAssetId: undefined,
                                        thumbnailGenerationStatus: "idle",
                                        thumbnailGenerationError: undefined,
                                        thumbnailTimestampSeconds: undefined,
                                        thumbnailSource: undefined,
                                      })
                                    }
                                    disabled={
                                      job.thumbnailGenerationStatus === "generating"
                                    }
                                    className={`py-1.5 border rounded text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                      job.thumbnailMode === "auto" ? "bg-zinc-200 border-zinc-300 text-zinc-900" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                                    }`}
                                  >
                                    Facebook Auto
                                  </button>
                                  <button
                                    onClick={() => {
                                      void handleUseOllamaBestFrame(job);
                                    }}
                                    disabled={
                                      !job.uploadValidated ||
                                      !job.assetId ||
                                      job.geminiAnalysisStatus === "analyzing" ||
                                      job.geminiAnalysisStatus === "queued" ||
                                      job.thumbnailGenerationStatus === "generating"
                                    }
                                    className={`py-1.5 border rounded text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                      job.thumbnailMode === "captured" &&
                                      job.thumbnailSource === "GEMINI_FRAME"
                                        ? "bg-indigo-100 border-indigo-300 text-indigo-800"
                                        : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                                    }`}
                                  >
                                    {job.geminiAnalysisStatus === "analyzing" &&
                                    job.thumbnailSource === "GEMINI_FRAME"
                                      ? "Ollama Finding..."
                                      : "Ollama Best"}
                                  </button>
                                  <button
                                    onClick={() => handleOpenFrameCaptureModal(job)}
                                    disabled={
                                      !job.uploadValidated ||
                                      !job.assetId ||
                                      job.thumbnailGenerationStatus === "generating"
                                    }
                                    className={`py-1.5 border rounded text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                      job.thumbnailMode === "captured" &&
                                      job.thumbnailSource === "MANUAL_FRAME"
                                        ? "bg-emerald-100 border-emerald-300 text-emerald-800"
                                        : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                                    }`}
                                  >
                                    Manual Frame
                                  </button>
                                  <div className="relative">
                                    <button
                                      disabled={
                                        job.thumbnailGenerationStatus === "generating"
                                      }
                                      className={`w-full py-1.5 border rounded text-[10px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                        job.thumbnailMode === "custom" ? "bg-zinc-200 border-zinc-300 text-zinc-900" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"
                                      }`}
                                    >
                                      Custom JPG
                                    </button>
                                    <input
                                      type="file"
                                      accept="image/jpeg,image/png"
                                      disabled={
                                        job.thumbnailGenerationStatus === "generating"
                                      }
                                      onChange={(e) => {
                                        if (e.target.files?.[0]) {
                                          const localUrl = URL.createObjectURL(e.target.files[0]);
                                          updateTempJobFields(job.id, {
                                            customThumbnailUrl: localUrl,
                                            thumbnailMode: "custom",
                                            thumbnailAssetId: undefined,
                                            thumbnailGenerationStatus: "idle",
                                            thumbnailGenerationError: undefined,
                                            thumbnailTimestampSeconds: undefined,
                                            thumbnailSource: undefined,
                                          });
                                          addSecurityLog("INFO", `Uploaded custom image ${e.target.files[0].name} for local preview only.`);
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
                                      className="aspect-video w-full rounded border border-zinc-200 object-cover"
                                    />
                                    <span className="text-[9px] text-zinc-500 mt-1 block">
                                      {job.thumbnailSource === "GEMINI_FRAME"
                                        ? "Ollama-selected video frame"
                                        : "Manually selected video frame"}
                                    </span>
                                  </div>
                                )}
                                {job.thumbnailMode === "custom" && job.customThumbnailUrl && (
                                  <div className="mt-2 text-center">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={job.customThumbnailUrl}
                                      alt="Custom Thumbnail Preview"
                                      className="aspect-video w-full rounded border border-zinc-200 object-cover"
                                    />
                                    <span className="text-[9px] text-amber-700 mt-1 block">Local preview only. Custom thumbnail storage is not connected yet.</span>
                                  </div>
                                )}
                                {job.thumbnailMode === "auto" && (
                                  <div className="text-[9px] text-zinc-500 bg-zinc-100 border border-zinc-200 rounded p-2 text-center mt-2 italic">
                                    Facebook will automatically generate the thumbnail.
                                  </div>
                                )}

                                {job.thumbnailMode === "captured" &&
                                  job.thumbnailGenerationStatus === "generating" && (
                                    <div className="mt-2 rounded border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-[9px] text-indigo-700">
                                      Generating and storing the permanent JPEG thumbnail...
                                    </div>
                                  )}

                                {job.thumbnailMode === "captured" &&
                                  job.thumbnailGenerationStatus === "complete" &&
                                  job.thumbnailAssetId && (
                                    <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[9px] text-emerald-800">
                                      {job.thumbnailSource === "GEMINI_FRAME"
                                        ? "Ollama thumbnail ready"
                                        : "Manual thumbnail ready"}
                                      {typeof job.thumbnailTimestampSeconds === "number"
                                        ? ` at ${job.thumbnailTimestampSeconds.toFixed(2)}s`
                                        : ""}.
                                    </div>
                                  )}

                                {job.thumbnailMode === "captured" &&
                                  job.thumbnailGenerationStatus === "error" &&
                                  job.thumbnailGenerationError && (
                                    <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[9px] text-rose-700">
                                      <div>{job.thumbnailGenerationError}</div>
                                      {job.assetId &&
                                        typeof job.thumbnailTimestampSeconds === "number" &&
                                        job.thumbnailSource && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              void handleGeneratePersistedThumbnail({
                                                jobId: job.id,
                                                assetId: job.assetId!,
                                                fileName: job.fileName,
                                                timestampSeconds: job.thumbnailTimestampSeconds!,
                                                source: job.thumbnailSource!,
                                              });
                                            }}
                                            className="mt-1 font-bold underline"
                                          >
                                            Retry permanent thumbnail
                                          </button>
                                        )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Editable Fields Column */}
                            <div className="flex-1 space-y-4 text-xs">

                              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                                  <div>
                                    <div className="text-[10px] font-mono uppercase tracking-wider text-indigo-700 font-bold">
                                      AI Content + Optional Ollama Thumbnail
                                    </div>
                                    <p className="mt-1 text-[10px] leading-relaxed text-indigo-700/80">
                                      Generates a title, caption, and exactly five hashtags in English by default. You may edit the title and caption in any language and use emojis or Unicode symbols. Thumbnail behavior is unchanged.
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => {
                                      void handleAnalyzeJobWithGemini(job);
                                    }}
                                    disabled={
                                      !job.uploadValidated ||
                                      !job.assetId ||
                                      job.geminiAnalysisStatus === "analyzing" ||
                                      job.geminiAnalysisStatus === "queued" ||
                                      (isBulkGeminiAnalysisRunning && activeBatchAssetIds.includes(job.assetId))
                                    }
                                    className="shrink-0 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-300 disabled:text-zinc-500 disabled:cursor-not-allowed px-4 py-2 text-[10px] font-bold text-white transition"
                                  >
                                    {job.geminiAnalysisStatus === "analyzing"
                                      ? "Analyzing..."
                                      : job.geminiAnalysisStatus === "complete"
                                        ? "Regenerate with AI"
                                        : "Generate with AI"}
                                  </button>
                                </div>

                                {job.geminiAnalysisStatus === "queued" && (
                                  <div className="mt-2 text-[10px] text-amber-600 animate-pulse font-semibold">
                                    Queued for AI analysis…
                                  </div>
                                )}

                                {job.geminiAnalysisStatus === "analyzing" && (
                                  <div className="mt-2 text-[10px] text-indigo-600 animate-pulse font-semibold">
                                    Analyzing video with local AI…
                                  </div>
                                )}

                                {job.geminiAnalysisStatus === "complete" && (
                                  <div className="mt-2 text-[10px] text-emerald-700 font-semibold">
                                    AI content generated successfully.
                                  </div>
                                )}

                                {job.geminiAnalysisStatus === "cancelled" && (
                                  <div className="mt-2 text-[10px] text-zinc-500 font-semibold">
                                    AI analysis cancelled.
                                  </div>
                                )}

                                {job.geminiAnalysisStatus === "error" &&
                                  job.geminiAnalysisError && (
                                    <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] text-rose-700">
                                      AI analysis failed: {job.geminiAnalysisError}
                                    </div>
                                  )}

                                {!job.uploadValidated && (
                                  <div className="mt-2 text-[10px] text-zinc-600">
                                    Available after the upload reaches Validated status.
                                  </div>
                                )}

                                {job.geminiAnalysisStatus === "complete" &&
                                  typeof job.geminiThumbnailTimestampSeconds === "number" && (
                                    <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[10px] leading-relaxed text-emerald-800">
                                      Selected frame: {job.geminiThumbnailTimestampSeconds.toFixed(2)}s.
                                      {job.geminiThumbnailReason
                                        ? ` ${job.geminiThumbnailReason}`
                                        : ""}
                                      {job.thumbnailGenerationStatus === "complete" && job.thumbnailAssetId
                                        ? " The permanent thumbnail is stored and linked for scheduling."
                                        : job.thumbnailGenerationStatus === "generating"
                                          ? " The permanent thumbnail is being generated."
                                          : job.capturedThumbnailUrl
                                            ? " A local preview is ready; permanent storage must succeed before scheduling."
                                            : " Permanent thumbnail generation must succeed before scheduling."}
                                    </div>
                                  )}
                              </div>

                              {/* Title input */}
                              <div>
                                <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">Title</label>
                                <input
                                  type="text"
                                  value={job.englishTitle}
                                  onChange={(e) => handleUpdateTempJobField(job.id, "englishTitle", e.target.value)}
                                  className="w-full bg-white border border-zinc-200 rounded-lg py-2 px-3 text-sm text-zinc-900 focus:outline-none focus:border-indigo-600 transition placeholder-zinc-400"
                                  placeholder="Title in any language — emojis supported"
                                />
                              </div>

                              {/* Caption text area */}
                              <div>
                                <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">Caption</label>
                                <textarea
                                  value={job.englishCaption}
                                  rows={2}
                                  onChange={(e) => handleUpdateTempJobField(job.id, "englishCaption", e.target.value)}
                                  className="w-full bg-white border border-zinc-200 rounded-lg py-2 px-3 text-sm text-zinc-900 focus:outline-none focus:border-indigo-600 transition placeholder-zinc-400"
                                  placeholder="Caption in any language — emojis supported"
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
                                    className="w-full bg-white border border-zinc-200 rounded-lg py-2 px-3 text-sm text-zinc-900 focus:outline-none focus:border-indigo-600 transition placeholder-zinc-400"
                                    placeholder="#Vlog #Reels"
                                  />
                                </div>

                                {/* Destination Facebook Page selector */}
                                <div>
                                  <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">Target Page</label>
                                  <select
                                    value={job.pageId || ""}
                                    onChange={(e) => handleUpdateTempJobField(job.id, "pageId", e.target.value)}
                                    className="w-full bg-white border border-zinc-200 rounded-lg py-2 px-3 text-sm text-zinc-900 focus:outline-none focus:border-indigo-600 transition"
                                  >
                                    <option value="">Select a page...</option>
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
                                  {job.contentType === "PHOTO" ? (
                                    <div className="w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
                                      Facebook Photo
                                    </div>
                                  ) : (
                                    <select
                                      value={job.contentType}
                                      onChange={(e) => handleUpdateTempJobField(job.id, "contentType", e.target.value as "VIDEO" | "REEL")}
                                      className="w-full bg-white border border-zinc-200 rounded-lg py-2 px-3 text-sm text-zinc-900 focus:outline-none focus:border-indigo-600 transition"
                                    >
                                      <option value="VIDEO">Facebook Video</option>
                                      <option value="REEL">Facebook Reel</option>
                                    </select>
                                  )}
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
                                    className="w-full bg-white border border-zinc-200 rounded-lg py-2 px-3 text-sm text-zinc-900 focus:outline-none focus:border-indigo-600 transition"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[10px] font-mono text-zinc-500 uppercase mb-1">
                                    Internal UTC ISO (Prisma Storage)
                                  </label>
                                  <div className="w-full bg-zinc-100 border border-zinc-200 rounded-lg py-2.5 px-3 font-mono text-zinc-500 break-all select-all">
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
                      <div className="text-center py-10 text-zinc-500 bg-zinc-50 border border-dashed border-zinc-200 rounded-xl">
                        Awaiting video uploads to display publishing configuration forms.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 3. SYNCED PAGES TAB */}
            {activeTab === "pages" && (
              <div className="bg-white border border-zinc-200 rounded-xl p-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 border-b border-zinc-200 pb-5">
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 mb-1">Connected Pages ({countPages})</h3>
                    <p className="text-xs text-zinc-500">
                      Manage connected credentials and monitor authorization token statuses.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => window.location.href = "/api/auth/facebook/initiate"}
                      className="bg-blue-600 hover:bg-blue-500 font-semibold text-xs text-white py-2.5 px-4 rounded-lg transition flex items-center justify-center gap-1.5"
                    >
                      Add Facebook Account
                    </button>
                  </div>
                </div>

                {accounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center bg-zinc-50 rounded-xl border border-dashed border-zinc-200">
                    <p className="text-sm text-zinc-700 font-semibold">No Facebook Accounts Connected</p>
                    <p className="text-xs text-zinc-500 mt-1 max-w-sm">
                      Please connect a Facebook account using the button above to synchronize your managed pages.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {accounts.map((account) => (
                      <div key={account.id} className="bg-zinc-50 border border-zinc-200 rounded-xl p-6 space-y-6">
                        {/* Account Header */}
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-zinc-200 pb-4">
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-600 border border-blue-200">
                              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                              </svg>
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="font-bold text-sm text-zinc-900">{account.name}</h4>
                                <span className={`text-[10px] border px-2 py-0.5 rounded font-mono font-semibold ${
                                  account.connectionState === 'Connected' ? "bg-emerald-50 text-emerald-800 border-emerald-200" :
                                  account.connectionState === 'Token Expiring' ? "bg-amber-50 text-amber-800 border-amber-200" :
                                  "bg-rose-50 text-rose-800 border-rose-200"
                                }`}>
                                  {account.connectionState.toUpperCase()}
                                </span>
                              </div>
                              <p className="text-xs text-zinc-500 font-mono mt-0.5">Meta User ID: {account.facebookUserId}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => handleSyncPages(account.id)}
                              disabled={isSyncingPages}
                              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-200 disabled:text-zinc-400 font-semibold text-xs text-white py-2 px-4 rounded-lg transition"
                            >
                              Refresh Pages
                            </button>
                            <button
                              onClick={() => window.location.href = "/api/auth/facebook/initiate"}
                              className="bg-blue-600 hover:bg-blue-500 font-semibold text-xs text-white py-2 px-4 rounded-lg transition"
                            >
                              Reconnect
                            </button>
                            <button
                              onClick={() => handleDisconnect(account.id)}
                              className="bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 font-semibold text-xs py-2 px-4 rounded-lg transition"
                            >
                              Disconnect
                            </button>
                            <button
                              onClick={() => handleSimulateTokenExpiry(account.connectionState !== 'Reconnection Required', account.id)}
                              className="bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 font-semibold text-xs py-2 px-4 rounded-lg transition"
                            >
                              {account.connectionState === 'Reconnection Required' ? "Restore Token" : "Expire Token"}
                            </button>
                          </div>
                        </div>

                        {/* Account Warning/Error Banners */}
                        {account.connectionState === "Reconnection Required" && (
                          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3.5 flex items-start gap-2.5 text-xs">
                            <svg className="h-5 w-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                            </svg>
                            <div>
                              <span className="font-bold block">Authorization Expired (Error 190)</span>
                              <span>The Facebook connection for this account has been invalidated or expired. Page synchronization is disabled, and scheduled publishes are blocked until you reconnect.</span>
                            </div>
                          </div>
                        )}

                        {account.connectionState === "Permission Missing" && (
                          <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg p-3.5 flex items-start gap-2.5 text-xs">
                            <svg className="h-5 w-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <div>
                              <span className="font-bold block">Missing Required Permissions</span>
                              <span>The application is missing the required <code className="bg-rose-100 text-rose-900 px-1 py-0.5 rounded font-mono text-[10px]">pages_manage_posts</code> permission. Video publishing and scheduled uploads will be blocked.</span>
                            </div>
                          </div>
                        )}

                        {account.connectionState === "Token Expiring" && (
                          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3.5 flex items-start gap-2.5 text-xs">
                            <svg className="h-5 w-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <div>
                              <span className="font-bold block">Token Expiring Soon</span>
                              <span>The Facebook API access token will expire in less than 7 days. Reconnection is recommended to prevent scheduled media publishing failures. Publishing will be blocked if expired.</span>
                            </div>
                          </div>
                        )}

                        {/* Account Pages List */}
                        {account.pages.length === 0 ? (
                          <div className="text-center py-8 text-zinc-500 text-xs bg-zinc-100/50 border border-dashed border-zinc-200 rounded-xl">
                            No synced pages found for this account.
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {account.pages.map((page) => (
                              <div
                                key={page.id}
                                className={`bg-white border rounded-xl p-5 hover:border-zinc-300 transition flex flex-col justify-between min-h-[160px] ${
                                  page.tokenStatus === "Expired" ? "border-rose-300 bg-rose-50/20" : "border-zinc-200"
                                }`}
                              >
                                <div className="flex items-start gap-4">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={page.pictureUrl}
                                    alt={page.name}
                                    className="h-11 w-11 rounded-lg bg-zinc-100 object-cover flex-shrink-0"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <h4 className="font-semibold text-sm text-zinc-900 truncate">{page.name}</h4>
                                    <span className="block text-[10px] text-zinc-500 mt-0.5">{page.category}</span>
                                    <span className="block text-[10px] font-mono text-zinc-500 mt-0.5">ID: {page.id}</span>
                                  </div>
                                </div>

                                <div className="mt-5 pt-4 border-t border-zinc-200 flex items-center justify-between text-xs">
                                  <div className="flex items-center gap-1.5">
                                    <span className={`h-2 w-2 rounded-full ${
                                      page.tokenStatus === "Expired" ? "bg-rose-500" : "bg-emerald-500"
                                    }`}></span>
                                    <span className={`font-mono text-[11px] ${
                                      page.tokenStatus === "Expired" ? "text-rose-700 font-semibold" : "text-emerald-700"
                                    }`}>
                                      Token: {page.tokenStatus}
                                    </span>
                                  </div>

                                  {page.tokenStatus === "Expired" ? (
                                    <button
                                      onClick={() => handleReconnectAccount(page.id)}
                                      className="bg-rose-600 hover:bg-rose-500 text-white font-bold text-[10px] px-3 py-1 rounded transition"
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
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 4. SECURITY LOGS TAB */}
            {activeTab === "logs" && (
              <div className="bg-white border border-zinc-200 rounded-xl p-6">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-200 pb-4">
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 mb-1">Security Audit Log Console</h3>
                    <p className="text-xs text-zinc-500">
                      Real-time mock operations output. Observe token encryption tags and parameter sanitization.
                    </p>
                  </div>
                  <button
                    onClick={() => setSecurityLogs([])}
                    className="text-xs text-zinc-600 hover:text-zinc-900 transition px-2.5 py-1 rounded border border-zinc-200 hover:bg-zinc-50 bg-white"
                  >
                    Clear Logs
                  </button>
                </div>

                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-5 font-mono text-xs text-zinc-300 min-h-[400px] overflow-y-auto space-y-2">
                  {securityLogs.length === 0 ? (
                    <p className="text-zinc-500 italic text-center py-10">No logs generated.</p>
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
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-200 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <h4 className="font-bold text-zinc-900 text-sm uppercase font-mono tracking-wide">Capture Thumbnail Frame</h4>
              <button
                onClick={() => setActiveFrameCaptureJobId(null)}
                className="text-zinc-500 hover:text-zinc-800 font-bold text-lg"
              >
                ×
              </button>
            </div>

            <div className="aspect-video bg-black rounded-lg overflow-hidden border border-zinc-200 relative flex items-center justify-center">
              {frameCaptureUrl ? (
                <video
                  ref={videoCaptureRef}
                  src={frameCaptureUrl}
                  className="h-full w-full object-contain"
                  crossOrigin="anonymous"
                />
              ) : (
                <div className="max-w-md px-6 text-center text-xs leading-5 text-zinc-300">
                  Local preview is unavailable after a page refresh.
                  Choose the timestamp below and the permanent frame
                  will be extracted server-side from the stored Google
                  Drive video.
                </div>
              )}
            </div>

            {/* Slider control */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs font-mono text-zinc-500">
                <span>Manual Position: {frameCaptureTime.toFixed(1)}s</span>
                <span>Total Length: {frameCaptureDuration}s</span>
              </div>
              <input
                type="range"
                min={0}
                max={frameCaptureDuration}
                step={0.1}
                value={frameCaptureTime}
                onChange={(e) => setFrameCaptureTime(Number(e.target.value))}
                className="w-full accent-indigo-600 h-1.5 bg-zinc-200 rounded-lg cursor-pointer"
              />
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-zinc-200 text-xs">
              <button
                onClick={() => setActiveFrameCaptureJobId(null)}
                className="px-4 py-2 border border-zinc-250 bg-white text-zinc-700 hover:bg-zinc-50 font-semibold rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={handleCaptureFrameAction}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg transition"
              >
                {frameCaptureUrl
                  ? "Use and Store Manual Frame"
                  : "Generate Permanent Thumbnail"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal before Scheduling saves to State */}
      {isConfirmationOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-200 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl p-6 flex flex-col gap-5">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <h4 className="font-bold text-zinc-900 text-base uppercase font-mono tracking-wide">Confirm Scheduling Batch</h4>
              <button
                onClick={() => setIsConfirmationOpen(false)}
                className="text-zinc-500 hover:text-zinc-800 font-bold text-lg"
              >
                ×
              </button>
            </div>

            <p className="text-xs text-zinc-500 leading-relaxed">
              Verify the local schedule conversions below. Confirming will create the corresponding scheduled tasks.
            </p>

            {/* Queue Summary list table */}
            <div className="border border-zinc-200 rounded-xl overflow-x-auto text-xs">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-200 text-zinc-600 font-mono text-[10px] uppercase">
                    <th className="p-3.5">Filename</th>
                    <th className="p-3.5">Content Type</th>
                    <th className="p-3.5">Target Page</th>
                    <th className="p-3.5">Local Time (Kolkata)</th>
                    <th className="p-3.5">UTC Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 bg-white font-mono">
                  {tempJobsQueue.map((job) => {
                    const targetPage = pages.find((p) => p.id === job.pageId);
                    return (
                      <tr key={job.id} className="hover:bg-zinc-50/50">
                        <td className="p-3.5 text-zinc-900 font-sans font-medium truncate max-w-[150px]">{job.fileName}</td>
                        <td className="p-3.5 font-bold text-indigo-600 text-[10px]">{job.contentType === "PHOTO" ? "Facebook Photo" : job.contentType === "REEL" ? "Facebook Reel" : "Facebook Video"}</td>
                        <td className="p-3.5 text-zinc-700 font-sans font-medium">{targetPage?.name || "Unassigned"}</td>
                        <td className="p-3.5 text-zinc-700">{formatDateTime(job.scheduledTimeKolkata)}</td>
                        <td className="p-3.5 text-zinc-500 break-all">{formatDateTime(job.scheduledTimeUTC)}Z</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex justify-end gap-3 pt-3 border-t border-zinc-200 text-xs">
                <button
                  onClick={() => setIsConfirmationOpen(false)}
                  disabled={isSavingJobs}
                  className="px-4 py-2 border border-zinc-250 bg-white text-zinc-700 hover:bg-zinc-50 font-semibold rounded-lg transition disabled:opacity-50"
                >
                  Go Back (Edit Details)
                </button>
                <button
                  onClick={handleConfirmSave}
                  disabled={isSavingJobs}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg transition shadow-md shadow-emerald-600/15 disabled:opacity-50"
                >
                  {isSavingJobs ? "Scheduling..." : "Confirm Batch Scheduling"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* History & Audit Logs Modal */}
      {selectedHistoryJob && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-zinc-200 rounded-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden shadow-2xl p-6 flex flex-col gap-4">

            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-200 pb-3">
              <div>
                <h4 className="font-bold text-zinc-900 text-base">Job History & Logs</h4>
                <p className="text-xs text-zinc-500 font-mono mt-0.5">{selectedHistoryJob.fileName} ({selectedHistoryJob.id})</p>
              </div>
              <button
                onClick={() => setSelectedHistoryJob(null)}
                className="text-zinc-500 hover:text-zinc-800 font-bold text-xl transition"
              >
                &times;
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-zinc-200 text-xs">
              <button
                onClick={() => setHistoryModalTab("attempts")}
                className={`px-4 py-2 border-b-2 font-bold transition ${
                  historyModalTab === "attempts"
                    ? "border-indigo-600 text-indigo-600"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
                }`}
              >
                Publish Attempts
              </button>
              <button
                onClick={() => setHistoryModalTab("audit")}
                className={`px-4 py-2 border-b-2 font-bold transition ${
                  historyModalTab === "audit"
                    ? "border-indigo-600 text-indigo-600"
                    : "border-transparent text-zinc-500 hover:text-zinc-800"
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
                    <div className="text-center py-10 text-zinc-500 italic bg-zinc-50 border border-dashed border-zinc-200 rounded-lg">
                      No publish attempts recorded yet. Process this job in the worker to see results.
                    </div>
                  ) : (
                    <div className="border border-zinc-200 rounded-xl overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-zinc-50 border-b border-zinc-200 text-zinc-600 font-mono text-[10px] uppercase">
                            <th className="p-3">Attempt</th>
                            <th className="p-3">Start (UTC)</th>
                            <th className="p-3">Completed (UTC)</th>
                            <th className="p-3">Resulting State</th>
                            <th className="p-3">Error Code</th>
                            <th className="p-3">Explanation</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-200 bg-white font-mono text-[11px]">
                          {selectedHistoryJob.attempts.map((attempt, index) => (
                            <tr key={index} className="hover:bg-zinc-50/50">
                              <td className="p-3 text-zinc-900 font-bold">#{attempt.attemptNumber}</td>
                              <td className="p-3 text-zinc-500">{formatDateTime(attempt.startTime)}</td>
                              <td className="p-3 text-zinc-500">{formatDateTime(attempt.completionTime)}</td>
                              <td className="p-3">
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${getStatusBadge(attempt.resultingState)}`}>
                                  {getStatusLabel(attempt.resultingState)}
                                </span>
                              </td>
                              <td className="p-3 text-rose-600 font-bold">{attempt.errorCode || "-"}</td>
                              <td className="p-3 text-zinc-700 font-sans">{attempt.explanation}</td>
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
                      return <p className="text-zinc-500 italic text-center py-6">No audit records found for this specific job.</p>;
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
            <div className="flex justify-end pt-3 border-t border-zinc-200">
              <button
                onClick={() => setSelectedHistoryJob(null)}
                className="px-4 py-2 bg-zinc-100 text-zinc-700 font-semibold rounded-lg hover:bg-zinc-200 transition"
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
