<template>
  <BaseModal
    :model-value="modelValue"
    aria-labelledby="gateway-token-reveal-title"
    :close-on-backdrop="false"
    :close-on-escape="false"
    role="alertdialog"
    @update:model-value="handleVisibility"
  >
    <template #default="{ overlayAttrs, panelAttrs, panelRef }">
      <div v-bind="overlayAttrs" class="token-modal">
        <div :ref="panelRef" v-bind="panelAttrs" class="token-modal__panel">
          <header class="token-modal__header">
            <span class="material-symbols-outlined token-modal__icon">key</span>
            <h3 id="gateway-token-reveal-title">{{ title }}</h3>
            <p>
              {{ description }}
              该令牌<strong>仅显示这一次</strong>，服务端只保存 HMAC digest，
              关闭后无法找回。请立即复制到安全的密钥库。
            </p>
          </header>

          <div class="token-modal__body">
            <div class="token-modal__meta" v-if="credential">
              <span class="token-modal__meta-item">
                <small>凭据 ID</small>
                <code>{{ credential.credentialId }}</code>
              </span>
              <span class="token-modal__meta-item" v-if="credential.boundAgentId">
                <small>绑定 Agent</small>
                <code>{{ credential.boundAgentId }}</code>
              </span>
              <span class="token-modal__meta-item" v-if="credential.expiresAt">
                <small>到期时间</small>
                <code>{{ credential.expiresAt.slice(0, 10) }}</code>
              </span>
            </div>

            <div class="token-modal__token-box">
              <code class="token-modal__token">{{ token }}</code>
              <div class="token-modal__token-actions">
                <UiButton variant="secondary" size="sm" @click="copyToken">
                  <template #leading>
                    <span class="material-symbols-outlined">content_copy</span>
                  </template>
                  {{ copied ? '已复制' : '复制令牌' }}
                </UiButton>
                <UiButton variant="outline" size="sm" @click="downloadTokenFile">
                  <template #leading>
                    <span class="material-symbols-outlined">download</span>
                  </template>
                  下载 .token.txt
                </UiButton>
              </div>
            </div>

            <label class="token-modal__ack">
              <AppCheckbox
                v-model="acknowledged"
                input-id="gateway-token-ack"
                label="我已将令牌保存到安全位置"
              />
            </label>
          </div>

          <footer class="token-modal__actions">
            <UiButton variant="danger" type="button" :disabled="!acknowledged" @click="emit('close')">
              关闭（令牌不再显示）
            </UiButton>
          </footer>
        </div>
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { GatewayCredentialView } from "@/api/agentGateway";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import BaseModal from "@/components/ui/BaseModal.vue";
import UiButton from "@/components/ui/UiButton.vue";

const props = defineProps<{
  modelValue: boolean;
  token: string;
  credential: GatewayCredentialView | null;
  title?: string;
  description?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const acknowledged = ref(false);
const copied = ref(false);

function handleVisibility(visible: boolean): void {
  if (!visible && acknowledged.value) {
    emit("close");
  }
}

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.token);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // 剪贴板 API 不可用时退化：选中令牌文本便于手动复制
    const range = document.createRange();
    const node = document.querySelector(".token-modal__token");
    if (node) {
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
}

// 浏览器端生成下载文件；服务端不落任何明文 token
function downloadTokenFile(): void {
  const credentialId = props.credential?.credentialId ?? "agent-gateway-credential";
  const body = `credentialId: ${credentialId}\ntoken: ${props.token}\nStore this token in a secure secret store now; it cannot be recovered.\n`;
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${credentialId}.token.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      acknowledged.value = false;
      copied.value = false;
    }
  }
);
</script>

<style scoped>
.token-modal {
  z-index: var(--z-index-modal);
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.token-modal__panel {
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - (var(--space-4) * 2)));
  max-height: calc(var(--app-viewport-height) - (var(--space-4) * 2));
  overflow-y: auto;
  border: 1px solid var(--warning-border, var(--border-color));
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.token-modal__header {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--warning-color, transparent) 8%, transparent);
}

.token-modal__icon {
  color: var(--warning-text, var(--primary-text));
  font-size: 1.5rem;
}

.token-modal__header h3 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-section-title);
}

.token-modal__header p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.6;
}

.token-modal__header strong {
  color: var(--danger-text, var(--primary-text));
}

.token-modal__body {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
}

.token-modal__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.token-modal__meta-item {
  display: grid;
  gap: 2px;
}

.token-modal__meta-item small {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.token-modal__meta-item code {
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.token-modal__token-box {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--primary-text) 1%, transparent);
}

.token-modal__token {
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-body);
  font-weight: 600;
  letter-spacing: 0.02em;
  word-break: break-all;
  color: var(--primary-text);
  user-select: all;
}

.token-modal__token-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.token-modal__ack {
  display: flex;
  align-items: center;
}

.token-modal__actions {
  display: flex;
  justify-content: flex-end;
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--border-color);
}
</style>
