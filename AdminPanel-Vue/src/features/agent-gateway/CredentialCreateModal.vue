<template>
  <BaseModal
    :model-value="modelValue"
    aria-labelledby="gateway-credential-create-title"
    :close-on-backdrop="!submitting"
    :close-on-escape="!submitting"
    @update:model-value="handleVisibility"
  >
    <template #default="{ overlayAttrs, panelAttrs, panelRef }">
      <div v-bind="overlayAttrs" class="credential-modal">
        <div :ref="panelRef" v-bind="panelAttrs" class="credential-modal__panel">
          <header class="credential-modal__header">
            <h3 id="gateway-credential-create-title">铸造 Agent 绑定凭据</h3>
            <p>
              生成一把仅绑定单个 agent 的 Gateway 密钥。令牌只在铸造完成后显示一次，
              服务端只保存 HMAC digest，无法找回。
            </p>
          </header>

          <form class="credential-modal__body" @submit.prevent="handleSubmit">
            <UiField label="绑定 Agent" description="凭据将以此 agent 的身份访问 Gateway 全部入口。" required for-id="gateway-create-agent">
              <UiSelect id="gateway-create-agent" v-model="formAgentId" :disabled="submitting" required>
                <option value="" disabled>请选择 agent…</option>
                <option v-for="agent in agents" :key="agent.agentId" :value="agent.agentId">
                  {{ agent.agentId }}<template v-if="agent.summary"> — {{ agent.summary }}</template>
                </option>
              </UiSelect>
            </UiField>

            <UiField
              label="凭据 ID"
              description="留空使用自动命名（agent-ext-年-月）。创建后不可修改，轮换需使用新 ID。"
              for-id="gateway-create-credential-id"
              :invalid="credentialIdInvalid"
              :error="credentialIdInvalid ? '仅小写字母、数字与连字符，长度 ≤64' : undefined"
            >
              <UiInput
                id="gateway-create-credential-id"
                v-model="formCredentialId"
                :disabled="submitting"
                :invalid="credentialIdInvalid"
                placeholder="例如 fupeng-ext-2026-08"
              />
            </UiField>

            <UiField label="权限 Scope" description="读取用于发现/召回，执行用于工具调用与记忆写入。" required>
              <div class="credential-modal__scopes">
                <AppCheckbox
                  v-model="formScopes.read"
                  input-id="gateway-create-scope-read"
                  label="gateway:read"
                  :disabled="submitting"
                />
                <AppCheckbox
                  v-model="formScopes.execute"
                  input-id="gateway-create-scope-execute"
                  label="gateway:execute"
                  :disabled="submitting"
                />
              </div>
            </UiField>

            <UiField label="有效期" description="到期后凭据自动失效，需要重新铸造。" required for-id="gateway-create-expiry">
              <div class="credential-modal__expiry">
                <UiSelect id="gateway-create-expiry" v-model="formExpiryPreset" :disabled="submitting">
                  <option value="90">90 天</option>
                  <option value="180">180 天（推荐）</option>
                  <option value="365">365 天</option>
                  <option value="custom">自定义日期</option>
                </UiSelect>
                <UiInput
                  v-if="formExpiryPreset === 'custom'"
                  v-model="formExpiryDate"
                  type="date"
                  :disabled="submitting"
                  :invalid="customExpiryInvalid"
                  aria-label="自定义到期日期"
                />
              </div>
            </UiField>

            <footer class="credential-modal__actions">
              <UiButton variant="secondary" type="button" :disabled="submitting" @click="emit('close')">
                取消
              </UiButton>
              <UiButton variant="primary" type="submit" :disabled="submitting || !canSubmit">
                {{ submitting ? "铸造中…" : "铸造并显示令牌" }}
              </UiButton>
            </footer>
          </form>
        </div>
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { GatewayAgentOption } from "@/api/agentGateway";
import AppCheckbox from "@/components/ui/AppCheckbox.vue";
import BaseModal from "@/components/ui/BaseModal.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiField from "@/components/ui/UiField.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";

const props = defineProps<{
  modelValue: boolean;
  agents: GatewayAgentOption[];
  submitting: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [payload: { boundAgentId: string; scopes: string[]; expiresAt: string; credentialId?: string }];
}>();

const CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const formAgentId = ref("");
const formCredentialId = ref("");
const formScopes = ref({ read: true, execute: true });
const formExpiryPreset = ref("180");
const formExpiryDate = ref("");

const selectedAgent = computed(() =>
  props.agents.find((agent) => agent.agentId === formAgentId.value)
);

const credentialIdInvalid = computed(
  () => formCredentialId.value.trim() !== "" && !CREDENTIAL_ID_PATTERN.test(formCredentialId.value.trim())
);

const customExpiryInvalid = computed(() => {
  if (formExpiryPreset.value !== "custom") {
    return false;
  }
  if (!formExpiryDate.value) {
    return true;
  }
  return Date.parse(`${formExpiryDate.value}T23:59:59.000Z`) <= Date.now();
});

const selectedScopes = computed(() => {
  const scopes: string[] = [];
  if (formScopes.value.read) scopes.push("gateway:read");
  if (formScopes.value.execute) scopes.push("gateway:execute");
  return scopes;
});

const canSubmit = computed(() =>
  Boolean(formAgentId.value)
  && selectedScopes.value.length > 0
  && !credentialIdInvalid.value
  && !customExpiryInvalid.value
);

function resolveExpiresAt(): string {
  if (formExpiryPreset.value === "custom") {
    return new Date(`${formExpiryDate.value}T23:59:59.000Z`).toISOString();
  }
  const days = Number(formExpiryPreset.value);
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

function handleSubmit(): void {
  if (!canSubmit.value || props.submitting) {
    return;
  }
  const trimmedId = formCredentialId.value.trim();
  emit("submit", {
    boundAgentId: formAgentId.value,
    scopes: selectedScopes.value,
    expiresAt: resolveExpiresAt(),
    ...(trimmedId ? { credentialId: trimmedId } : {})
  });
}

function handleVisibility(visible: boolean): void {
  if (!visible && !props.submitting) {
    emit("close");
  }
}

function resetForm(): void {
  formAgentId.value = "";
  formCredentialId.value = "";
  formScopes.value = { read: true, execute: true };
  formExpiryPreset.value = "180";
  formExpiryDate.value = "";
}

watch(
  () => [props.modelValue, formAgentId.value] as const,
  ([isOpen, agentId], [wasOpen]) => {
    if (isOpen && !wasOpen) {
      resetForm();
    }
    if (isOpen && agentId && selectedAgent.value) {
      formCredentialId.value = selectedAgent.value.suggestedCredentialId;
    }
  }
);
</script>

<style scoped>
.credential-modal {
  z-index: var(--z-index-modal);
  display: grid;
  place-items: center;
  padding: var(--space-4);
  background: var(--overlay-backdrop-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.credential-modal__panel {
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - (var(--space-4) * 2)));
  max-height: calc(var(--app-viewport-height) - (var(--space-4) * 2));
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--secondary-bg);
  box-shadow: var(--overlay-panel-shadow);
}

.credential-modal__header {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--border-color);
}

.credential-modal__header h3 {
  margin: 0;
  color: var(--primary-text);
  font-size: var(--font-size-section-title);
}

.credential-modal__header p {
  margin: 0;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
  line-height: 1.55;
}

.credential-modal__body {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
}

.credential-modal__scopes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.credential-modal__expiry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-2);
}

.credential-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-color);
}
</style>
