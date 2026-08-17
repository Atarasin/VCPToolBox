<template>
  <UiTableFrame density="compact">
    <thead>
      <tr>
        <th>状态</th>
        <th>凭据 ID</th>
        <th>绑定 Agent</th>
        <th>Scope</th>
        <th>到期时间</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="credential in credentials" :key="credential.credentialId">
        <td>
          <UiBadge :variant="statusBadgeVariant(credential.status)">
            {{ statusLabel(credential.status) }}
          </UiBadge>
        </td>
        <td>
          <div class="credential-id-cell">
            <code>{{ credential.credentialId }}</code>
            <UiIconButton
              label="复制凭据 ID"
              :title="`复制凭据 ID ${credential.credentialId}（令牌仅在铸造/轮换时显示一次，此处不可复制）`"
              size="sm"
              @click="emit('copyId', credential.credentialId)"
            >
              <span class="material-symbols-outlined">content_copy</span>
            </UiIconButton>
          </div>
        </td>
        <td>
          <span v-if="credential.boundAgentId">{{ credential.boundAgentId }}</span>
          <span v-else class="muted-text">未绑定（admin 级）</span>
        </td>
        <td>
          <div class="scope-cell">
            <UiBadge v-for="scope in credential.scopes" :key="scope" variant="outline">
              {{ scope }}
            </UiBadge>
          </div>
        </td>
        <td>
          <div class="expiry-cell">
            <span>{{ formatExpiry(credential.expiresAt) }}</span>
            <small v-if="credential.status === 'rotating' && credential.expiresAt">
              剩余 {{ relativeExpiry(credential.expiresAt) }}
            </small>
          </div>
        </td>
        <td>
          <div class="actions-cell">
            <UiButton
              variant="secondary"
              size="xs"
              :disabled="!canRotate(credential)"
              @click="emit('rotate', credential)"
            >
              轮换
            </UiButton>
            <UiButton
              variant="danger"
              size="xs"
              :disabled="credential.status === 'revoked'"
              @click="emit('revoke', credential)"
            >
              吊销
            </UiButton>
          </div>
        </td>
      </tr>
    </tbody>
  </UiTableFrame>
  <UiEmptyState
    v-if="credentials.length === 0"
    title="暂无凭据"
    description="尚无任何 agent 对外凭据。点击右上角「铸造凭据」为 agent 生成第一把绑定密钥。"
  >
    <template #icon>
      <span class="material-symbols-outlined">vpn_key_off</span>
    </template>
  </UiEmptyState>
</template>

<script setup lang="ts">
import type { GatewayCredentialStatus, GatewayCredentialView } from "@/api/agentGateway";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiIconButton from "@/components/ui/UiIconButton.vue";
import UiTableFrame from "@/components/ui/UiTableFrame.vue";

defineProps<{
  credentials: GatewayCredentialView[];
}>();

const emit = defineEmits<{
  rotate: [credential: GatewayCredentialView];
  revoke: [credential: GatewayCredentialView];
  copyId: [credentialId: string];
}>();

const STATUS_LABELS: Record<GatewayCredentialStatus, string> = {
  active: "生效中",
  rotating: "轮换过渡",
  revoked: "已吊销",
  expired: "已过期",
};

function statusLabel(status: GatewayCredentialStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function statusBadgeVariant(status: GatewayCredentialStatus) {
  switch (status) {
    case "active":
      return "success" as const;
    case "rotating":
      return "warning" as const;
    case "revoked":
      return "danger" as const;
    default:
      return "secondary" as const;
  }
}

function canRotate(credential: GatewayCredentialView): boolean {
  return credential.status === "active" || credential.status === "rotating";
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) {
    return "长期有效";
  }
  return expiresAt.slice(0, 10);
}

function relativeExpiry(expiresAt: string): string {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (remainingMs <= 0) {
    return "已到期";
  }
  const days = Math.floor(remainingMs / (24 * 3600 * 1000));
  if (days >= 1) {
    return `${days} 天`;
  }
  const hours = Math.max(1, Math.floor(remainingMs / (3600 * 1000)));
  return `${hours} 小时`;
}
</script>

<style scoped>
.credential-id-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.credential-id-cell code {
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.scope-cell,
.actions-cell {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.expiry-cell {
  display: grid;
  gap: 2px;
}

.expiry-cell small {
  color: var(--warning-text, var(--secondary-text));
  font-size: var(--font-size-caption);
}

.muted-text {
  color: var(--secondary-text);
}
</style>
