import { requestWithUi, type RequestUiOptions } from "./requestWithUi";

/**
 * Agent Gateway 凭据管理 API。
 * 后端：routes/admin/agentGateway.js（/admin_api/agent-gateway/*，主进程单写者）。
 * 设计：modules/agentGateway/docs/agent-integration/08-adminpanel-agent-credential-manager.md
 */

const API_BASE_URL = "/admin_api/agent-gateway";
const DEFAULT_READ_UI_OPTIONS: RequestUiOptions = { showLoader: false };

export type GatewayCredentialStatus = "active" | "rotating" | "revoked" | "expired";

export interface GatewayCredentialView {
  credentialId: string;
  pepperKid: string;
  boundAgentId: string | null;
  allowedAgents?: string[];
  scopes: string[];
  status: GatewayCredentialStatus;
  expiresAt: string | null;
  credentialRevision: string;
}

export interface GatewaySnapshotReason {
  field: string;
  reason: string;
  errors?: { path: string; message: string }[];
}

export interface GatewayStatus {
  configured: boolean;
  credentialsPath: string | null;
  pepperKeyringPath: string | null;
  activeKid: string | null;
  activeKidMissing: boolean;
  pepperKids: string[];
  snapshotAvailable: boolean;
  snapshotReasons: GatewaySnapshotReason[];
  total: number;
  statusCounts: Record<string, number>;
}

export interface GatewayAgentOption {
  agentId: string;
  alias: string;
  summary: string;
  suggestedCredentialId: string;
  /** 导出 skill 的目录名（vcp-<agent>）；guidance 未发布时为 null */
  skillName: string | null;
}

export interface SkillArchiveDownload {
  blob: Blob;
  filename: string;
}

export interface CreateCredentialPayload {
  boundAgentId: string;
  scopes: string[];
  expiresAt: string;
  credentialId?: string;
}

export interface CreateCredentialResponse {
  credential: GatewayCredentialView;
  token: string;
}

export interface RotateCredentialPayload {
  oldExpiresAt: string;
  newCredentialId?: string;
  expiresAt?: string | null;
}

export interface RotateCredentialResponse {
  previous: GatewayCredentialView;
  credential: GatewayCredentialView;
  token: string;
}

export interface CredentialListFilters {
  status?: string;
  boundAgentId?: string;
}

export const agentGatewayApi = {
  async getStatus(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<GatewayStatus> {
    const response = await requestWithUi<{ status: GatewayStatus }>(
      { url: `${API_BASE_URL}/status` },
      uiOptions
    );
    return response.status;
  },

  async listAgents(
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<GatewayAgentOption[]> {
    const response = await requestWithUi<{ agents: GatewayAgentOption[] }>(
      { url: `${API_BASE_URL}/agents` },
      uiOptions
    );
    return response.agents;
  },

  async listCredentials(
    filters: CredentialListFilters = {},
    uiOptions: RequestUiOptions = DEFAULT_READ_UI_OPTIONS
  ): Promise<GatewayCredentialView[]> {
    const response = await requestWithUi<{ credentials: GatewayCredentialView[] }>(
      {
        url: `${API_BASE_URL}/credentials`,
        query: {
          status: filters.status || undefined,
          boundAgentId: filters.boundAgentId || undefined,
        },
      },
      uiOptions
    );
    return response.credentials;
  },

  async createCredential(
    payload: CreateCredentialPayload,
    uiOptions: RequestUiOptions = {}
  ): Promise<CreateCredentialResponse> {
    return requestWithUi<CreateCredentialResponse>(
      {
        url: `${API_BASE_URL}/credentials`,
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async rotateCredential(
    credentialId: string,
    payload: RotateCredentialPayload,
    uiOptions: RequestUiOptions = {}
  ): Promise<RotateCredentialResponse> {
    return requestWithUi<RotateCredentialResponse>(
      {
        url: `${API_BASE_URL}/credentials/${encodeURIComponent(credentialId)}/rotate`,
        method: "POST",
        body: payload,
      },
      uiOptions
    );
  },

  async revokeCredential(
    credentialId: string,
    uiOptions: RequestUiOptions = {}
  ): Promise<{ credential: GatewayCredentialView }> {
    return requestWithUi<{ credential: GatewayCredentialView }>(
      {
        url: `${API_BASE_URL}/credentials/${encodeURIComponent(credentialId)}/revoke`,
        method: "POST",
      },
      uiOptions
    );
  },

  /**
   * 导出 agent 接入 skill（zip 附件）。响应是二进制而非 JSON，
   * 走原生 fetch（cookie 鉴权与 httpClient 一致），失败时手工解析 JSON 错误体。
   */
  async downloadSkillArchive(agentId: string): Promise<SkillArchiveDownload> {
    const response = await fetch(
      `${API_BASE_URL}/agents/${encodeURIComponent(agentId)}/skill`,
      { credentials: "same-origin" }
    );
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) {
          message = body.error;
        }
      } catch {
        // 非 JSON 错误体时保留状态码信息
      }
      throw new Error(message);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const filename = match && match[1] ? match[1] : `${agentId}.zip`;
    return { blob: await response.blob(), filename };
  },
};
