<template>
  <div
    v-if="bannerVariant !== 'ok'"
    :class="['gateway-banner', `gateway-banner--${bannerVariant}`]"
    role="status"
  >
    <span class="material-symbols-outlined gateway-banner__icon">{{ bannerIcon }}</span>
    <div class="gateway-banner__body">
      <strong>{{ bannerTitle }}</strong>
      <p>{{ bannerMessage }}</p>
    </div>
  </div>
  <div v-if="okStatus" class="gateway-banner gateway-banner--ok" role="status">
    <div class="gateway-banner__meta">
      <span class="gateway-banner__item">
        <span class="material-symbols-outlined">key</span>
        {{ okStatus.total }} 条凭据
        <template v-if="okStatus.statusCounts.active">· {{ okStatus.statusCounts.active }} 生效</template>
        <template v-if="okStatus.statusCounts.rotating">· {{ okStatus.statusCounts.rotating }} 轮换中</template>
        <template v-if="okStatus.statusCounts.revoked">· {{ okStatus.statusCounts.revoked }} 已吊销</template>
      </span>
      <span v-if="okStatus.credentialsPath" class="gateway-banner__item gateway-banner__path" :title="okStatus.credentialsPath">
        <span class="material-symbols-outlined">description</span>
        {{ okStatus.credentialsPath }}
      </span>
      <span v-if="okStatus.pepperKids.length" class="gateway-banner__item" title="pepper keyring 中的可用 kid">
        <span class="material-symbols-outlined">shield</span>
        kid: {{ okStatus.activeKid || '未设置' }}
        <template v-if="okStatus.pepperKids.length > 1">（共 {{ okStatus.pepperKids.length }} 把）</template>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { GatewayStatus } from "@/api/agentGateway";

const props = defineProps<{
  status: GatewayStatus | null;
}>();

const bannerVariant = computed<"ok" | "warn" | "danger">(() => {
  if (!props.status) {
    return "warn";
  }
  if (!props.status.snapshotAvailable) {
    return "danger";
  }
  if (!props.status.configured || props.status.activeKidMissing) {
    return "warn";
  }
  return "ok";
});

// 模板内的非空收窄入口：仅当状态读取成功且无告警时渲染摘要条
const okStatus = computed(() =>
  bannerVariant.value === "ok" ? props.status : null
);

const bannerIcon = computed(() =>
  bannerVariant.value === "danger" ? "gpp_bad" : "warning"
);

const bannerTitle = computed(() => {
  if (!props.status) {
    return "正在读取网关凭据状态…";
  }
  if (!props.status.snapshotAvailable) {
    return "凭据快照不可用（fail-closed）";
  }
  if (!props.status.configured) {
    return "凭据文件未配置";
  }
  return "缺少活跃 pepper kid";
});

const bannerMessage = computed(() => {
  if (!props.status) {
    return "如果长时间无响应，请确认主进程已启动。";
  }
  if (!props.status.snapshotAvailable) {
    const reasons = props.status.snapshotReasons
      .map((item) => `${item.field}: ${item.reason}`)
      .join("；");
    return `认证链路已拒绝发布安全快照，请检查配置文件后重试。${reasons}`;
  }
  if (!props.status.configured) {
    return "请在 config.env 设置 AGENT_GATEWAY_CREDENTIALS_PATH（与 PEPPERS_PATH）并重启；铸造与轮换操作在配置前不可用。";
  }
  return "请在 config.env 设置 AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID 为 keyring 中的某个 kid；铸造与轮换操作在设置前不可用。";
});
</script>

<style scoped>
.gateway-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 0.8%, transparent);
}

.gateway-banner--warn {
  border-color: var(--warning-border, var(--border-color));
  background: var(--warning-bg, transparent);
  color: var(--warning-text, var(--primary-text));
}

.gateway-banner--danger {
  border-color: var(--danger-border, var(--border-color));
  background: var(--danger-bg, transparent);
  color: var(--danger-text, var(--primary-text));
}

.gateway-banner__icon {
  font-size: 1.25rem;
  line-height: 1.4;
}

.gateway-banner__body {
  display: grid;
  gap: 4px;
}

.gateway-banner__body p {
  margin: 0;
  font-size: var(--font-size-helper);
  line-height: 1.55;
  opacity: 0.9;
}

.gateway-banner__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.gateway-banner__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.gateway-banner__item .material-symbols-outlined {
  font-size: 1rem;
  color: var(--secondary-text);
}

.gateway-banner__path {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
</style>
