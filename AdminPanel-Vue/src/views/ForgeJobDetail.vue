<template>
  <section class="config-section active-section forge-job-detail-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge variant="outline">只读观察</UiBadge>
        <UiButton type="button" :disabled="loading" :loading="loading" @click="refresh">
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="detail-intro">
      <RouterLink class="back-link" :to="{ name: 'ForgeJobs' }">← 返回任务列表</RouterLink>
      <h2>
        铸造任务
        <span v-if="detail?.job.displayName || detail?.job.expertName" class="expert-name">
          · {{ detail?.job.displayName || detail?.job.expertName }}
        </span>
      </h2>
      <p v-if="detail" class="mono-cell">{{ detail.job.jobId }}</p>
    </header>

    <UiEmptyState
      v-if="loadError"
      :title="loadError.status >= 500 ? '读取任务详情失败' : '任务不存在'"
      :description="loadError.message"
    />

    <template v-if="detail">
      <section class="detail-grid">
        <!-- 概览 -->
        <UiSettingsCard
          class="detail-surface"
          title="任务概览"
          description="类型、状态、需求与预算（只读）。"
          variant="subtle"
        >
          <dl class="overview-list">
            <div>
              <dt>类型</dt>
              <dd>{{ detail.job.type === 'learn' ? '增量学习（forge.expert.learn）' : '全量铸造（forge.expert.create）' }}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <UiBadge :variant="statusVariant(detail.job.status)">{{ statusLabel(detail.job.status) }}</UiBadge>
                <span v-if="detail.job.pendingConfirm" class="hint-text"> · 等待用户确认画像</span>
                <span v-if="detail.job.budgetPaused" class="hint-text"> · 预算耗尽暂停</span>
              </dd>
            </div>
            <div v-if="detail.run?.requirement">
              <dt>需求</dt>
              <dd>{{ detail.run.requirement }}</dd>
            </div>
            <div>
              <dt>预算</dt>
              <dd>
                {{ formatCny(detail.cost?.budgetCny ?? detail.run?.budgetCny ?? null) }}
                <span v-if="(detail.cost?.costSoFarCny ?? 0) > 0">
                  · 已花费 {{ formatCny(detail.cost?.costSoFarCny) }}
                </span>
              </dd>
            </div>
            <div v-if="detail.job.error">
              <dt>错误</dt>
              <dd class="danger-text">
                {{ detail.job.error.code }}：{{ detail.job.error.message }}
              </dd>
            </div>
            <div>
              <dt>创建 / 更新</dt>
              <dd>{{ formatTime(detail.job.createdAt) }} / {{ formatTime(detail.job.updatedAt) }}</dd>
            </div>
          </dl>
        </UiSettingsCard>

        <!-- 五步时间线 -->
        <UiSettingsCard
          class="detail-surface"
          title="步骤时间线"
          description="五步状态机的逐步状态与产物。"
          variant="subtle"
        >
          <ol class="step-timeline">
            <li
              v-for="(step, index) in detail.job.steps"
              :key="step.id"
              :class="['step-item', `step-item--${step.status}`]"
            >
              <span class="step-index">{{ index + 1 }}</span>
              <div class="step-body">
                <div class="step-head">
                  <strong>{{ step.name }}</strong>
                  <span class="step-status">{{ stepStatusLabel(step.status) }}</span>
                </div>
                <p v-if="step.summary" class="step-summary">{{ step.summary }}</p>
                <p v-if="step.completedAt" class="step-meta">{{ formatTime(step.completedAt) }}</p>
                <ul v-if="step.artifacts.length" class="step-artifacts">
                  <li v-for="artifact in step.artifacts" :key="artifact" class="mono-cell">{{ artifact }}</li>
                </ul>
              </div>
            </li>
          </ol>
        </UiSettingsCard>

        <!-- 费用明细 -->
        <UiSettingsCard
          class="detail-surface"
          title="费用明细"
          description="逐次模型/插件调用的费用估算（元）。"
          variant="subtle"
        >
          <template v-if="detail.cost">
            <div class="cost-bar-track" role="img" :aria-label="costAriaLabel">
              <div
                class="cost-bar-fill"
                :class="{ 'cost-bar-fill--warn': costRatio >= 0.9 }"
                :style="{ width: `${Math.min(100, costRatio * 100)}%` }"
              ></div>
            </div>
            <p class="cost-caption">
              {{ formatCny(detail.cost.costSoFarCny) }} / {{ formatCny(detail.cost.budgetCny) }}
              （告警线 {{ formatCny(detail.cost.warnThresholdCny) }}）
            </p>
            <UiTableFrame v-if="byModelRows.length" density="compact">
              <thead>
                <tr><th>模型/插件</th><th>类型</th><th>次数</th><th>费用</th></tr>
              </thead>
              <tbody>
                <tr v-for="row in byModelRows" :key="row.key">
                  <td class="mono-cell">{{ row.key }}</td>
                  <td>{{ row.kind }}</td>
                  <td>{{ row.calls }}</td>
                  <td>{{ formatCny(row.costCny) }}</td>
                </tr>
              </tbody>
            </UiTableFrame>
            <details class="cost-entries">
              <summary>逐次调用（{{ detail.cost.entries.length }} 条）</summary>
              <ul>
                <li v-for="(entry, index) in detail.cost.entries" :key="index" class="mono-cell">
                  #{{ index + 1 }} [{{ entry.step || '—' }}]
                  {{ entry.kind === 'llm' ? `${entry.model} (${entry.promptTokens ?? 0}+${entry.completionTokens ?? 0} tok)` : entry.plugin }}
                  → {{ formatCny(entry.costCny) }}
                </li>
              </ul>
            </details>
          </template>
          <p v-else class="hint-text">暂无费用记录。</p>
        </UiSettingsCard>

        <!-- 产物档案 -->
        <UiSettingsCard
          class="detail-surface"
          title="产物档案"
          description="本次运行在 Agent/forge/runs/ 下的落盘文件。"
          variant="subtle"
        >
          <ul v-if="detail.artifacts.length" class="artifact-list">
            <li v-for="artifact in detail.artifacts" :key="artifact.path">
              <span class="mono-cell">{{ artifact.path }}</span>
              <small class="hint-text">{{ formatBytes(artifact.bytes) }}</small>
            </li>
          </ul>
          <p v-else class="hint-text">暂无落盘产物。</p>
        </UiSettingsCard>

        <!-- 审计事件流 -->
        <UiSettingsCard
          class="detail-surface"
          title="事件时间线"
          description="job 运行时事件流（含进度与费用快照）。"
          variant="subtle"
        >
          <ul v-if="detail.events.length" class="event-stream">
            <li v-for="event in detail.events" :key="event.eventId">
              <span class="mono-cell event-type">{{ event.eventType }}</span>
              <span class="event-time">{{ formatTime(event.timestamp) }}</span>
              <span v-if="eventProgress(event)" class="hint-text">{{ eventProgress(event) }}</span>
            </li>
          </ul>
          <p v-else class="hint-text">暂无事件。</p>
        </UiSettingsCard>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiSettingsCard from "@/components/ui/UiSettingsCard.vue";
import UiTableFrame from "@/components/ui/UiTableFrame.vue";
import {
  forgeApi,
  type ForgeJobDetail,
  type ForgeJobStatus,
  type ForgeTimelineEvent,
} from "@/api/forge";
import { usePolling } from "@/composables/usePolling";

const route = useRoute();
const detail = ref<ForgeJobDetail | null>(null);
const loading = ref(false);
const loadError = ref<{ status: number; message: string } | null>(null);

const jobId = computed(() => String(route.params.jobId || ""));

async function loadDetail() {
  try {
    detail.value = await forgeApi.getJobDetail(jobId.value);
    loadError.value = null;
  } catch (error) {
    const typed = error as { status?: number; message?: string };
    loadError.value = {
      status: typed?.status ?? 500,
      message: typed?.message ?? String(error),
    };
  }
}

async function refresh() {
  loading.value = true;
  try {
    await loadDetail();
  } finally {
    loading.value = false;
  }
}

const polling = usePolling(loadDetail, {
  interval: 5000,
  immediate: false,
  onError: () => undefined,
});

onMounted(async () => {
  await refresh();
  polling.start();
});

const costRatio = computed(() => {
  const cost = detail.value?.cost;
  if (!cost || !cost.budgetCny || cost.budgetCny <= 0) {
    return 0;
  }
  return cost.costSoFarCny / cost.budgetCny;
});

const costAriaLabel = computed(
  () => `已花费 ${formatCny(detail.value?.cost?.costSoFarCny ?? null)} / 预算 ${formatCny(detail.value?.cost?.budgetCny ?? null)}`
);

const byModelRows = computed(() => {
  const byModel = detail.value?.cost?.byModel ?? {};
  return Object.entries(byModel).map(([key, value]) => ({ key, ...value }));
});

function statusVariant(status: ForgeJobStatus) {
  switch (status) {
    case "running":
    case "accepted":
      return "info";
    case "pending_confirm":
      return "purple";
    case "paused_budget":
      return "warning";
    case "failed":
      return "danger";
    case "completed":
      return "success";
    default:
      return "outline";
  }
}

function statusLabel(status: ForgeJobStatus) {
  const labels: Record<ForgeJobStatus, string> = {
    accepted: "已受理",
    running: "运行中",
    pending_confirm: "待确认",
    paused_budget: "预算暂停",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status] || status;
}

function stepStatusLabel(status: string) {
  const labels: Record<string, string> = {
    completed: "已完成",
    running: "进行中",
    pending: "待执行",
  };
  return labels[status] || status;
}

function eventProgress(event: ForgeTimelineEvent) {
  const progress = event.data?.metadata?.forge?.progress;
  if (!progress) {
    return "";
  }
  const parts: string[] = [];
  if (progress.step) {
    parts.push(String(progress.step));
  }
  if (typeof progress.costSoFarCny === "number") {
    parts.push(formatCny(progress.costSoFarCny));
  }
  return parts.join(" · ");
}

function formatCny(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `¥${value.toFixed(2)}`;
}

function formatTime(iso: string | null | undefined) {
  if (!iso) {
    return "—";
  }
  return iso.replace("T", " ").slice(0, 19);
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<style scoped>
.detail-intro {
  margin-bottom: var(--space-4);
}

.back-link {
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
  text-decoration: none;
}

.back-link:hover {
  color: var(--accent, #3b82f6);
}

.expert-name {
  font-size: var(--font-size-body);
  color: var(--text-secondary);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--space-4);
}

.overview-list {
  display: grid;
  gap: var(--space-2);
  margin: 0;
}

.overview-list > div {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: var(--space-2);
}

.overview-list dt {
  color: var(--text-secondary);
}

.overview-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.step-timeline {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.step-item {
  display: flex;
  gap: var(--space-3);
}

.step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-color);
  font-size: var(--font-size-caption);
}

.step-item--completed .step-index {
  border-color: var(--success, #22c55e);
  color: var(--success, #22c55e);
}

.step-item--running .step-index {
  border-color: var(--accent, #3b82f6);
  color: var(--accent, #3b82f6);
}

.step-body {
  flex: 1;
  min-width: 0;
}

.step-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

.step-status {
  color: var(--text-secondary);
  font-size: var(--font-size-caption);
}

.step-summary,
.step-meta {
  margin: 2px 0 0;
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
}

.step-artifacts {
  margin: 4px 0 0;
  padding-left: var(--space-4);
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
}

.cost-bar-track {
  width: 100%;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--border-color);
  overflow: hidden;
}

.cost-bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent, #3b82f6);
  transition: width 0.3s ease;
}

.cost-bar-fill--warn {
  background: var(--warning, #f59e0b);
}

.cost-caption {
  margin: var(--space-2) 0;
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
}

.cost-entries {
  margin-top: var(--space-3);
  font-size: var(--font-size-caption);
}

.cost-entries ul {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  color: var(--text-secondary);
}

.artifact-list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--font-size-caption);
}

.artifact-list li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}

.event-stream {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--font-size-caption);
}

.event-stream li {
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  flex-wrap: wrap;
}

.event-type {
  color: var(--accent, #3b82f6);
}

.event-time {
  color: var(--text-secondary);
}

.mono-cell {
  font-family: var(--font-mono, monospace);
}

.hint-text {
  color: var(--text-secondary);
  font-size: var(--font-size-caption);
}

.danger-text {
  color: var(--danger, #ef4444);
}
</style>
