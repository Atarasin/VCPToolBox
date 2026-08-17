<template>
  <section class="config-section active-section agent-gateway-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiButton
          variant="secondary"
          :loading="refreshing"
          @click="reloadAll"
        >
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
        <UiButton
          variant="primary"
          :disabled="!mutationsReady"
          :title="mutationsReady ? '' : '凭据文件或 pepper kid 未就绪，见下方状态提示'"
          @click="createModalOpen = true"
        >
          <template #leading>
            <span class="material-symbols-outlined">add_key</span>
          </template>
          铸造凭据
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="agent-gateway-intro">
      <h2>Agent 对外网关</h2>
      <p>
        管理通过 Agent Gateway（MCP / REST）对外暴露的 agent 绑定密钥：铸造、轮换与吊销。
        令牌只在铸造或轮换后的一次性弹窗中显示，关闭后无法找回（服务端仅存摘要）；
        表格中的复制按钮复制的是凭据 ID，不是令牌。令牌遗失后请轮换换取新令牌；
        吊销后空闲连接会在约 1 分钟内断开。
      </p>
    </header>

    <GatewayStatusBanner :status="status" />

    <UiToolbar density="compact">
      <UiInput
        v-model="searchQuery"
        size="sm"
        placeholder="搜索凭据 ID…"
        aria-label="搜索凭据 ID"
      />
      <UiSelect v-model="agentFilter" size="sm" aria-label="按绑定 Agent 过滤">
        <option value="">全部 Agent</option>
        <option v-for="agent in boundAgentOptions" :key="agent" :value="agent">
          {{ agent }}
        </option>
      </UiSelect>
      <UiSelect v-model="statusFilter" size="sm" aria-label="按状态过滤">
        <option value="">全部状态</option>
        <option value="active">生效中</option>
        <option value="rotating">轮换过渡</option>
        <option value="revoked">已吊销</option>
        <option value="expired">已过期</option>
      </UiSelect>
      <template #actions>
        <span class="agent-gateway-count">{{ filteredCredentials.length }} 条</span>
      </template>
    </UiToolbar>

    <CredentialTable
      :credentials="filteredCredentials"
      @rotate="onRotate"
      @revoke="onRevoke"
      @copy-id="copyCredentialId"
    />

    <CredentialCreateModal
      :model-value="createModalOpen"
      :agents="agents"
      :submitting="creating"
      @close="createModalOpen = false"
      @submit="onCreate"
    />

    <TokenRevealModal
      :model-value="tokenModalOpen"
      :token="revealedToken"
      :credential="revealedCredential"
      :title="revealedTitle"
      :description="revealedDescription"
      @close="tokenModalOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  agentGatewayApi,
  type GatewayAgentOption,
  type GatewayCredentialView,
  type GatewayStatus,
} from "@/api/agentGateway";
import CredentialCreateModal from "@/features/agent-gateway/CredentialCreateModal.vue";
import CredentialTable from "@/features/agent-gateway/CredentialTable.vue";
import GatewayStatusBanner from "@/features/agent-gateway/GatewayStatusBanner.vue";
import TokenRevealModal from "@/features/agent-gateway/TokenRevealModal.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiToolbar from "@/components/ui/UiToolbar.vue";
import { askConfirm, askInput } from "@/platform/feedback/feedbackBus";
import { copyToClipboard, showMessage } from "@/utils";

const status = ref<GatewayStatus | null>(null);
const agents = ref<GatewayAgentOption[]>([]);
const credentials = ref<GatewayCredentialView[]>([]);

const refreshing = ref(false);
const creating = ref(false);
const createModalOpen = ref(false);
const tokenModalOpen = ref(false);
const revealedToken = ref("");
const revealedCredential = ref<GatewayCredentialView | null>(null);
const revealedTitle = ref("令牌已生成");
const revealedDescription = ref("");

const searchQuery = ref("");
const agentFilter = ref("");
const statusFilter = ref("");

const mutationsReady = computed(() => {
  const current = status.value;
  return current !== null
    && current.configured
    && current.snapshotAvailable
    && !current.activeKidMissing;
});

const boundAgentOptions = computed(() =>
  Array.from(
    new Set([
      ...agents.value.map((agent) => agent.agentId),
      ...credentials.value
        .map((credential) => credential.boundAgentId)
        .filter((agentId): agentId is string => Boolean(agentId)),
    ])
  ).sort((a, b) => a.localeCompare(b))
);

const filteredCredentials = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return credentials.value.filter((credential) => {
    if (query && !credential.credentialId.toLowerCase().includes(query)) {
      return false;
    }
    if (agentFilter.value && credential.boundAgentId !== agentFilter.value) {
      return false;
    }
    if (statusFilter.value && credential.status !== statusFilter.value) {
      return false;
    }
    return true;
  });
});

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function reloadAll(): Promise<void> {
  refreshing.value = true;
  try {
    const [nextStatus, nextAgents, nextCredentials] = await Promise.all([
      agentGatewayApi.getStatus(),
      agentGatewayApi.listAgents().catch(() => [] as GatewayAgentOption[]),
      agentGatewayApi.listCredentials(),
    ]);
    status.value = nextStatus;
    agents.value = nextAgents;
    credentials.value = nextCredentials;
  } catch (error) {
    showMessage(`加载网关凭据信息失败：${describeError(error)}`, "error");
  } finally {
    refreshing.value = false;
  }
}

async function refreshStatusAndCredentials(): Promise<void> {
  const [nextStatus, nextCredentials] = await Promise.all([
    agentGatewayApi.getStatus(),
    agentGatewayApi.listCredentials(),
  ]);
  status.value = nextStatus;
  credentials.value = nextCredentials;
}

function showTokenModal(token: string, credential: GatewayCredentialView, title: string, description: string): void {
  revealedToken.value = token;
  revealedCredential.value = credential;
  revealedTitle.value = title;
  revealedDescription.value = description;
  tokenModalOpen.value = true;
}

async function onCreate(payload: {
  boundAgentId: string;
  scopes: string[];
  expiresAt: string;
  credentialId?: string;
}): Promise<void> {
  creating.value = true;
  try {
    const result = await agentGatewayApi.createCredential(payload, { suppressErrorMessage: true });
    await refreshStatusAndCredentials();
    createModalOpen.value = false;
    showTokenModal(
      result.token,
      result.credential,
      "令牌已生成",
      `已为 ${result.credential.boundAgentId ?? "agent"} 铸造凭据。`
    );
  } catch (error) {
    showMessage(`铸造失败：${describeError(error)}`, "error");
  } finally {
    creating.value = false;
  }
}

async function onRotate(credential: GatewayCredentialView): Promise<void> {
  const confirmed = await askConfirm({
    title: "轮换凭据",
    message: `将创建新凭据替换 "${credential.credentialId}"（绑定 ${credential.boundAgentId ?? "未绑定"}）。旧令牌将在设定的窗口结束后失效，新令牌立即生效。`,
    confirmText: "继续",
  });
  if (!confirmed) {
    return;
  }
  const daysInput = await askInput({
    title: "旧令牌失效窗口",
    message: "旧令牌在多少天后失效？（外部客户端需要在此窗口内完成切换）",
    initialValue: "7",
    required: true,
    confirmText: "开始轮换",
    validate: (value) => {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        return "请输入 1–365 之间的整数天数";
      }
      return null;
    },
  });
  if (daysInput === null) {
    return;
  }
  const days = Number(daysInput);
  const oldExpiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  try {
    const result = await agentGatewayApi.rotateCredential(credential.credentialId, {
      oldExpiresAt,
    });
    await refreshStatusAndCredentials();
    showTokenModal(
      result.token,
      result.credential,
      "新令牌已生成",
      `旧凭据 ${result.previous.credentialId} 已进入轮换过渡（${days} 天后失效）。`
    );
  } catch (error) {
    showMessage(`轮换失败：${describeError(error)}`, "error");
  }
}

async function onRevoke(credential: GatewayCredentialView): Promise<void> {
  const confirmed = await askConfirm({
    title: "吊销凭据",
    message: `确定吊销 "${credential.credentialId}"（绑定 ${credential.boundAgentId ?? "未绑定"}）？该操作不可恢复：新认证立即失败，已建立的空闲连接会在约 1 分钟内断开。`,
    danger: true,
    confirmText: "吊销",
  });
  if (!confirmed) {
    return;
  }
  try {
    await agentGatewayApi.revokeCredential(credential.credentialId);
    await refreshStatusAndCredentials();
    showMessage(`已吊销 ${credential.credentialId}`, "success");
  } catch (error) {
    showMessage(`吊销失败：${describeError(error)}`, "error");
  }
}

async function copyCredentialId(credentialId: string): Promise<void> {
  // 面板常经局域网 HTTP 访问（非安全上下文），须用带 execCommand 回退的共享工具
  const success = await copyToClipboard(credentialId);
  if (success) {
    showMessage(`已复制 ${credentialId}`, "success");
  } else {
    showMessage("复制失败，请手动选择复制", "error");
  }
}

onMounted(() => {
  void reloadAll();
});
</script>

<style scoped>
.agent-gateway-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.agent-gateway-intro {
  display: grid;
  gap: var(--space-1);
}

.agent-gateway-intro h2 {
  margin: 0;
  color: var(--primary-text);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.4;
}

.agent-gateway-intro p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.agent-gateway-count {
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  white-space: nowrap;
}
</style>
