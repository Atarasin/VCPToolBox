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
};
