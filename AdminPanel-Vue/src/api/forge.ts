import { requestWithUi, type RequestUiOptions } from "./requestWithUi";

/**
 * 专家铸造炉只读进度 API。
 * 后端：routes/admin/forge.js（/admin_api/forge/*，admin 鉴权）。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.10（R5 增补，只读观察窗口）。
 *
 * 本模块只包含 GET 只读操作——面板不提供发起铸造、确认画像、重试、取消
 * 等任何写入口（发起与控制唯一走铸造师对话，D1）。
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
};
