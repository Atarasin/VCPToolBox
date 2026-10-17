import { requestWithUi, type RequestUiOptions } from "./requestWithUi";

/**
 * 专家铸造炉只读进度 API。
 * 后端：routes/admin/forge.js（/admin_api/forge/*，admin 鉴权）。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.10（R5 增补，只读观察窗口）。
 *
 * 本模块只包含 GET 只读操作——面板不提供发起铸造、确认画像、重试、取消
 * 等任何写入口（发起与控制唯一走铸造师对话，D1）。
 * 专家档案（/experts*）：缺口（gaps.json）与进修记录（learning-history.jsonl）
 * 的只读投影，供「专家铸造」页的专家档案页签使用。
 */

const API_BASE_URL = "/admin_api/forge";
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export type ForgeJobStatus =
  | "accepted"
  | "running"
  | "pending_confirm"
  | "paused_budget"
  | "completed"
  | "failed"
  | "cancelled";

export type ForgeJobType = "create" | "learn";

export interface ForgeStepState {
  id: string;
  name: string;
  status: "completed" | "running" | "pending";
  completedAt: string | null;
  summary: string | null;
  artifacts: string[];
}

export interface ForgeJobSummary {
  jobId: string;
  operation: string;
  jobKind: string;
  type: ForgeJobType;
  expertName: string | null;
  displayName: string | null;
  status: ForgeJobStatus;
  terminal: boolean;
  currentStep: string | null;
  steps: ForgeStepState[];
  costSoFarCny: number;
  budgetCny: number | null;
  pendingConfirm: { kind: string; blueprintPath: string | null; hint?: string } | null;
  budgetPaused: { step: string; breakdown: { costSoFarCny: number; budgetCny: number } } | null;
  error: { step?: string; code?: string; message?: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

export interface ForgeCostEntry {
  kind: "llm" | "tool";
  model?: string;
  plugin?: string;
  promptTokens?: number;
  completionTokens?: number;
  costCny: number;
  step: string | null;
}

export interface ForgeCostDetail {
  costSoFarCny: number;
  budgetCny: number;
  warnThresholdCny: number;
  byModel: Record<string, { kind: string; calls: number; costCny: number }>;
  entries: ForgeCostEntry[];
}

export interface ForgeRunArtifact {
  path: string;
  bytes: number;
}

export interface ForgeTimelineEvent {
  eventId: string;
  eventType: string;
  jobId: string;
  timestamp: string;
  data: {
    status?: string;
    operation?: string;
    metadata?: { forge?: { progress?: { step?: string | null; detail?: string; costSoFarCny?: number } } };
  };
}

export interface ForgeJobDetail {
  job: ForgeJobSummary;
  forge: Record<string, unknown>;
  run: {
    jobId: string;
    jobKind: string;
    requirement: string | null;
    expertName: string | null;
    budgetCny: number | null;
    blueprintApproved: boolean;
    budgetRaises: { to: number; at: string }[];
  } | null;
  cost: ForgeCostDetail | null;
  artifacts: ForgeRunArtifact[];
  events: ForgeTimelineEvent[];
}

export interface ForgeGap {
  id: string;
  ts: string;
  status: "open" | "closed";
  subskillId: string | null;
  question: string;
  whyInsufficient: string | null;
  closedAt?: string;
}

export interface ForgeLearningScope {
  subskillIds?: string[];
  topic?: string;
  reason?: string;
}

export interface ForgeLearningEntry {
  ts: string;
  trigger: string | null;
  scope: ForgeLearningScope | null;
  /** 缺省视为 completed（2026-10-14 之前的历史条目无此字段）。 */
  status?: "completed" | "failed";
  error?: {
    step?: string | null;
    code?: string | null;
    message?: string | null;
  } | null;
  sources: number;
  /** 失败条目也可能 >0：失败步骤已完成的部分入库（2026-10-17 起带回）。 */
  distilledFiles: number;
  /** 失败步骤的部分进度明细（仅部分入库的失败条目有）。 */
  partial?: { writtenCount: number; mergedCount: number } | null;
  costCny?: number | null;
  jobId: string | null;
}

export interface ForgeExpertSummary {
  expertName: string;
  displayName: string | null;
  /** 归档 = 退役：不再被定期进修触发、不再接受新进修；档案仍可回看。 */
  archived: boolean;
  archivedAt: string | null;
  totalGaps: number;
  openGaps: number;
  learningCount: number;
  failedCount: number;
  lastLearningAt: string | null;
}

export interface ForgeExpertRecord {
  expertName: string;
  displayName: string | null;
  gaps: ForgeGap[];
  learningHistory: ForgeLearningEntry[];
}

export const forgeApi = {
  async listJobs(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ForgeJobSummary[]> {
    const response = await requestWithUi<{ status: string; jobs: ForgeJobSummary[] }>(
      { url: `${API_BASE_URL}/jobs` },
      uiOptions
    );
    return response.jobs || [];
  },

  async getJobDetail(
    jobId: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ForgeJobDetail> {
    const response = await requestWithUi<
      ForgeJobDetail & { status: string }
    >(
      { url: `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}` },
      uiOptions
    );
    const { status: _status, ...detail } = response;
    return detail;
  },

  async listExperts(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ForgeExpertSummary[]> {
    const response = await requestWithUi<{ status: string; experts: ForgeExpertSummary[] }>(
      { url: `${API_BASE_URL}/experts` },
      uiOptions
    );
    return response.experts || [];
  },

  async getExpertRecord(
    expertName: string,
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<ForgeExpertRecord> {
    const response = await requestWithUi<
      ForgeExpertRecord & { status: string }
    >(
      { url: `${API_BASE_URL}/experts/${encodeURIComponent(expertName)}` },
      uiOptions
    );
    const { status: _status, ...record } = response;
    return record;
  },
};
