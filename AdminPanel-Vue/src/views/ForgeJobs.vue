<template>
  <section class="config-section active-section forge-jobs-page">
    <Teleport to="#page-header-actions">
      <UiPageActions>
        <UiBadge variant="outline">只读观察</UiBadge>
        <UiButton type="button" :disabled="loading" :loading="loading" @click="refreshActive">
          <template #leading>
            <span class="material-symbols-outlined">refresh</span>
          </template>
          刷新
        </UiButton>
      </UiPageActions>
    </Teleport>

    <header class="forge-intro">
      <h2>专家铸造</h2>
      <p>
        铸造任务的进度、费用与历史观察窗口（只读），以及每个专家的知识缺口与进修档案。
        发起铸造、确认画像、重试与取消均通过铸造师对话完成，本页面不提供任何操作入口。
      </p>
    </header>

    <nav class="forge-tabs" role="tablist" aria-label="专家铸造视图切换">
      <button
        v-for="tab in FORGE_TABS"
        :key="tab.id"
        type="button"
        role="tab"
        class="forge-tab"
        :class="{ 'forge-tab--active': activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="switchTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <template v-if="activeTab === 'jobs'">
      <section class="forge-summary" aria-label="铸造任务摘要">
      <span class="summary-item">
        <strong>{{ jobs.length }}</strong>
        <small>全部任务</small>
      </span>
      <span class="summary-item">
        <strong>{{ countByStatus('running') + countByStatus('pending_confirm') + countByStatus('paused_budget') }}</strong>
        <small>进行中</small>
      </span>
      <span class="summary-item">
        <strong>{{ countByStatus('completed') }}</strong>
        <small>已完成</small>
      </span>
      <span class="summary-item">
        <strong>{{ countByStatus('failed') + countByStatus('cancelled') }}</strong>
        <small>失败/取消</small>
      </span>
    </section>

    <UiEmptyState
      v-if="!loading && jobs.length === 0"
      title="暂无铸造任务"
      description="在铸造师对话中发起「造一个 XX 专家」后，任务进度会出现在这里。"
    />

    <UiTableFrame v-else density="compact" class="forge-table">
      <thead>
        <tr>
          <th>任务</th>
          <th>类型</th>
          <th>专家</th>
          <th>状态</th>
          <th>当前步骤</th>
          <th>费用 / 预算</th>
          <th>创建 / 更新</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="job.jobId">
          <td class="mono-cell" :title="job.jobId">{{ shortJobId(job.jobId) }}</td>
          <td>
            <UiBadge :variant="job.type === 'learn' ? 'secondary' : 'info'">
              {{ job.type === 'learn' ? '增量学习' : '全量铸造' }}
            </UiBadge>
          </td>
          <td>{{ job.displayName || job.expertName || '—' }}</td>
          <td>
            <UiBadge :variant="statusVariant(job.status)">{{ statusLabel(job.status) }}</UiBadge>
            <p v-if="job.error?.code" class="cell-sub danger-text" :title="job.error.message">
              {{ job.error.code }}
            </p>
          </td>
          <td>
            <span v-if="stepLabel(job)">{{ stepLabel(job) }}</span>
            <span v-else class="muted-text">—</span>
            <p v-if="job.pendingConfirm" class="cell-sub">等待画像确认</p>
          </td>
          <td class="cost-cell">
            <div class="cost-bar-track" role="img" :aria-label="`已花费 ${formatCny(job.costSoFarCny)} / 预算 ${formatCny(job.budgetCny)}`">
              <div
                class="cost-bar-fill"
                :class="{ 'cost-bar-fill--warn': costRatio(job) >= 0.9 }"
                :style="{ width: `${Math.min(100, costRatio(job) * 100)}%` }"
              ></div>
            </div>
            <small class="cell-sub">
              {{ formatCny(job.costSoFarCny) }} / {{ job.budgetCny == null ? '未设预算' : formatCny(job.budgetCny) }}
            </small>
          </td>
          <td class="mono-cell">
            <div>{{ formatTime(job.createdAt) }}</div>
            <div class="cell-sub">{{ formatTime(job.updatedAt) }}</div>
          </td>
          <td>
            <RouterLink
              class="forge-detail-link"
              :to="{ name: 'ForgeJobDetail', params: { jobId: job.jobId } }"
            >
              详情
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </UiTableFrame>
    </template>

    <ForgeExpertsPanel v-else ref="expertsPanel" />
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiPageActions from "@/components/ui/UiPageActions.vue";
import UiTableFrame from "@/components/ui/UiTableFrame.vue";
import ForgeExpertsPanel from "@/components/forge/ForgeExpertsPanel.vue";
import { forgeApi, type ForgeJobStatus, type ForgeJobSummary } from "@/api/forge";
import { usePolling } from "@/composables/usePolling";

type ForgeTabId = "jobs" | "experts";

const FORGE_TABS: { id: ForgeTabId; label: string }[] = [
  { id: "jobs", label: "铸造任务" },
  { id: "experts", label: "专家档案" },
];

const activeTab = ref<ForgeTabId>("jobs");
const expertsPanel = ref<InstanceType<typeof ForgeExpertsPanel> | null>(null);

const jobs = ref<ForgeJobSummary[]>([]);
const loading = ref(false);

async function loadJobs() {
  jobs.value = await forgeApi.listJobs();
}

async function refresh() {
  loading.value = true;
  try {
    await loadJobs();
  } finally {
    loading.value = false;
  }
}

// 刷新按钮跟随当前页签：任务列表在页内刷新，专家档案委托给子面板。
async function refreshActive() {
  if (activeTab.value === "experts") {
    await expertsPanel.value?.refresh();
    return;
  }
  await refresh();
}

function switchTab(tab: ForgeTabId) {
  activeTab.value = tab;
}

// 自动轮询进度（只读拉取；页面卸载时 usePolling 自行停止）。
const polling = usePolling(loadJobs, {
  interval: 5000,
  immediate: false,
  onError: () => undefined,
});

// 只有任务页签需要轮询——专家档案是低频变化的运行数据，按需刷新即可。
watch(activeTab, (tab) => {
  if (tab === "jobs") {
    polling.start();
  } else {
    polling.stop();
  }
});

onMounted(async () => {
  await refresh();
  polling.start();
});

function countByStatus(status: ForgeJobStatus) {
  return jobs.value.filter((job) => job.status === status).length;
}

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

function stepLabel(job: ForgeJobSummary) {
  const running = job.steps.find((step) => step.status === "running");
  if (running) {
    const index = job.steps.indexOf(running) + 1;
    return `${index}. ${running.name}`;
  }
  if (job.pendingConfirm) {
    return "画像等待确认";
  }
  if (job.status === "completed") {
    return "全部完成";
  }
  return "";
}

function costRatio(job: ForgeJobSummary) {
  if (!job.budgetCny || job.budgetCny <= 0) {
    return 0;
  }
  return job.costSoFarCny / job.budgetCny;
}

function shortJobId(jobId: string) {
  return jobId.length > 18 ? `${jobId.slice(0, 12)}…` : jobId;
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
</script>

<style scoped>
.forge-intro {
  margin-bottom: var(--space-4);
}

.forge-tabs {
  display: flex;
  gap: var(--space-1);
  margin-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

.forge-tab {
  padding: var(--space-2) var(--space-3);
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
}

.forge-tab:hover {
  color: inherit;
}

.forge-tab--active {
  color: var(--accent, #3b82f6);
  border-bottom-color: var(--accent, #3b82f6);
}

.forge-intro p {
  margin: var(--space-1) 0 0;
  color: var(--text-secondary);
}

.forge-summary {
  display: flex;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.summary-item strong {
  font-size: var(--font-size-title);
}

.summary-item small {
  color: var(--text-secondary);
}

.mono-cell {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-caption);
}

.cell-sub {
  margin: 2px 0 0;
  font-size: var(--font-size-caption);
  color: var(--text-secondary);
}

.cost-cell {
  min-width: 140px;
}

.cost-bar-track {
  width: 100%;
  height: 6px;
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

.forge-detail-link {
  color: var(--accent, #3b82f6);
  text-decoration: none;
}

.forge-detail-link:hover {
  text-decoration: underline;
}

.muted-text {
  color: var(--text-secondary);
}

.danger-text {
  color: var(--danger, #ef4444);
}
</style>
