<template>
  <div class="forge-experts">
    <UiEmptyState
      v-if="!loading && experts.length === 0"
      title="暂无专家档案"
      description="铸造出第一个专家（或在对话中登记知识缺口）后，缺口与进修记录会出现在这里。"
    />

    <div v-else class="experts-layout">
      <aside class="experts-list" aria-label="专家列表">
        <button
          v-for="expert in experts"
          :key="expert.expertName"
          type="button"
          class="expert-item"
          :class="{
            'expert-item--active': expert.expertName === selectedName,
            'expert-item--archived': expert.archived,
          }"
          @click="selectExpert(expert.expertName)"
        >
          <span class="expert-item__name">{{ expert.displayName || expert.expertName }}</span>
          <span class="expert-item__meta">
            <UiBadge v-if="expert.archived" variant="outline" :title="`归档于 ${formatTime(expert.archivedAt)}，不再触发定期进修`">
              已归档
            </UiBadge>
            <UiBadge :variant="expert.openGaps > 0 ? 'warning' : 'outline'">
              {{ expert.openGaps }} 未关闭缺口
            </UiBadge>
            <UiBadge v-if="expert.failedCount > 0" variant="danger">
              {{ expert.failedCount }} 次失败
            </UiBadge>
            <small>
              进修 {{ expert.learningCount }} 次 · {{ formatTime(expert.lastLearningAt) }}
            </small>
          </span>
        </button>
      </aside>

      <section class="expert-detail" aria-label="专家档案详情">
        <UiEmptyState
          v-if="!selectedName"
          title="选择左侧专家查看档案"
          description="含全量知识缺口（未关闭/已关闭）与历次进修记录。"
        />

        <template v-else>
          <header class="detail-head">
            <h3>{{ record?.displayName || selectedName }}</h3>
            <span class="mono-cell muted-text">{{ selectedName }}</span>
            <UiBadge
              v-if="selectedExpert?.archived"
              variant="outline"
              :title="`归档于 ${formatTime(selectedExpert.archivedAt)}`"
            >
              已归档（不再触发定期进修）
            </UiBadge>
          </header>

          <section class="detail-block">
            <h4>
              知识缺口
              <UiBadge variant="outline">{{ record?.gaps.length || 0 }} 条</UiBadge>
              <UiBadge v-if="openGapCount > 0" variant="warning">{{ openGapCount }} 条未关闭</UiBadge>
            </h4>
            <UiEmptyState
              v-if="!record || record.gaps.length === 0"
              title="暂无缺口记录"
              description="专家答不好时通过 gateway_gap_report 登记，这里是只读回看。"
            />
            <UiTableFrame v-else density="compact" class="forge-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>子技能</th>
                  <th>问题</th>
                  <th>为什么不足</th>
                  <th>登记 / 关闭</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="gap in sortedGaps" :key="gap.id">
                  <td>
                    <UiBadge :variant="gap.status === 'open' ? 'warning' : 'success'">
                      {{ gap.status === 'open' ? '未关闭' : '已关闭' }}
                    </UiBadge>
                  </td>
                  <td class="mono-cell">{{ gap.subskillId || '—' }}</td>
                  <td class="wrap-cell">{{ gap.question }}</td>
                  <td class="wrap-cell muted-text">{{ gap.whyInsufficient || '—' }}</td>
                  <td class="mono-cell">
                    <div>{{ formatTime(gap.ts) }}</div>
                    <div v-if="gap.closedAt" class="cell-sub">关 {{ formatTime(gap.closedAt) }}</div>
                  </td>
                </tr>
              </tbody>
            </UiTableFrame>
          </section>

          <section class="detail-block">
            <h4>
              进修记录
              <UiBadge variant="outline">{{ record?.learningHistory.length || 0 }} 次</UiBadge>
            </h4>
            <UiEmptyState
              v-if="!record || record.learningHistory.length === 0"
              title="暂无进修记录"
              description="手动进修、试岗缺口回填与定期进修完成后会在 learning-history.jsonl 留档。"
            />
            <UiTableFrame v-else density="compact" class="forge-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>触发</th>
                  <th>范围</th>
                  <th>结果 / 失败原因</th>
                  <th>任务</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in learningRows" :key="`${entry.ts}-${entry.jobId || ''}`">
                  <td class="mono-cell">{{ formatTime(entry.ts) }}</td>
                  <td>
                    <UiBadge :variant="entry.status === 'failed' ? 'danger' : 'success'">
                      {{ entry.status === 'failed' ? '失败' : '完成' }}
                    </UiBadge>
                  </td>
                  <td>
                    <UiBadge :variant="triggerVariant(entry.trigger)">{{ triggerLabel(entry.trigger) }}</UiBadge>
                  </td>
                  <td class="wrap-cell" :title="scopeTitle(entry.scope)">{{ scopeLabel(entry.scope) }}</td>
                  <td class="wrap-cell">
                    <template v-if="entry.status === 'failed'">
                      <span class="danger-text mono-cell">{{ entry.error?.code || 'FAILED' }}</span>
                      <p class="cell-sub" :title="entry.error?.message || ''">
                        {{ entry.error?.step ? `[${entry.error.step}] ` : '' }}{{ entry.error?.message || '未知原因' }}
                      </p>
                      <p v-if="entry.distilledFiles > 0" class="cell-sub">
                        已写盘 {{ entry.distilledFiles }} 个新文件<template v-if="entry.partial?.mergedCount"> / {{ entry.partial.mergedCount }} 次合并</template>（部分入库，产物保留）
                      </p>
                    </template>
                    <template v-else>
                      <span>{{ entry.sources }} 来源 / {{ entry.distilledFiles }} 卡</span>
                      <p v-if="entry.costCny != null" class="cell-sub">¥{{ Number(entry.costCny).toFixed(2) }}</p>
                    </template>
                  </td>
                  <td>
                    <RouterLink
                      v-if="entry.jobId"
                      class="forge-detail-link mono-cell"
                      :to="{ name: 'ForgeJobDetail', params: { jobId: entry.jobId } }"
                      :title="entry.jobId"
                    >
                      {{ shortJobId(entry.jobId) }}
                    </RouterLink>
                    <span v-else class="muted-text">—</span>
                  </td>
                </tr>
              </tbody>
            </UiTableFrame>
          </section>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import UiBadge from "@/components/ui/UiBadge.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiTableFrame from "@/components/ui/UiTableFrame.vue";
import {
  forgeApi,
  type ForgeExpertRecord,
  type ForgeExpertSummary,
  type ForgeLearningScope,
} from "@/api/forge";

const experts = ref<ForgeExpertSummary[]>([]);
const selectedName = ref<string | null>(null);
const record = ref<ForgeExpertRecord | null>(null);
const loading = ref(false);

async function loadExperts() {
  experts.value = await forgeApi.listExperts();
  if (experts.value.length === 0) {
    selectedName.value = null;
    record.value = null;
    return;
  }
  const stillExists = experts.value.some((expert) => expert.expertName === selectedName.value);
  if (!stillExists) {
    selectedName.value = experts.value[0].expertName;
  }
  await loadRecord();
}

async function loadRecord() {
  if (!selectedName.value) {
    record.value = null;
    return;
  }
  record.value = await forgeApi.getExpertRecord(selectedName.value);
}

async function refresh() {
  loading.value = true;
  try {
    await loadExperts();
  } finally {
    loading.value = false;
  }
}

function selectExpert(expertName: string) {
  if (expertName === selectedName.value) {
    return;
  }
  selectedName.value = expertName;
  loadRecord().catch(() => undefined);
}

onMounted(() => {
  refresh().catch(() => undefined);
});

defineExpose({ refresh });

const sortedGaps = computed(() => {
  const gaps = record.value?.gaps || [];
  return [...gaps].sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
});

const learningRows = computed(() => {
  const rows = record.value?.learningHistory || [];
  return [...rows].reverse();
});

const openGapCount = computed(() => (record.value?.gaps || []).filter((gap) => gap.status === "open").length);

const selectedExpert = computed(
  () => experts.value.find((expert) => expert.expertName === selectedName.value) || null
);

const TRIGGER_LABELS: Record<string, string> = {
  manual: "手动",
  "trial-failed-gap-backfill": "试岗缺口回填",
};

function triggerLabel(trigger: string | null) {
  if (!trigger) {
    return "—";
  }
  if (TRIGGER_LABELS[trigger]) {
    return TRIGGER_LABELS[trigger];
  }
  if (trigger.startsWith("scheduled-")) {
    return `定期·${trigger.slice("scheduled-".length)}`;
  }
  return trigger;
}

function triggerVariant(trigger: string | null) {
  if (trigger === "trial-failed-gap-backfill") {
    return "warning";
  }
  if (trigger && trigger.startsWith("scheduled-")) {
    return "purple";
  }
  if (trigger === "manual") {
    return "info";
  }
  return "outline";
}

function scopeLabel(scope: ForgeLearningScope | null) {
  const subskillIds = scope?.subskillIds;
  if (Array.isArray(subskillIds) && subskillIds.length > 0) {
    return subskillIds.join("、");
  }
  if (scope?.topic) {
    return `主题：${scope.topic}`;
  }
  return "全量子技能";
}

function scopeTitle(scope: ForgeLearningScope | null) {
  const subskillIds = scope?.subskillIds;
  if (Array.isArray(subskillIds) && subskillIds.length > 0) {
    return `子技能：${subskillIds.join("、")}`;
  }
  return scopeLabel(scope);
}

function shortJobId(jobId: string) {
  return jobId.length > 18 ? `${jobId.slice(0, 12)}…` : jobId;
}

function formatTime(iso: string | null | undefined) {
  if (!iso) {
    return "—";
  }
  return iso.replace("T", " ").slice(0, 19);
}
</script>

<style scoped>
.experts-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

@media (max-width: 900px) {
  .experts-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.experts-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  border-right: 1px solid var(--border-color);
  padding-right: var(--space-3);
  max-height: 70vh;
  overflow-y: auto;
}

.expert-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md, 8px);
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.expert-item:hover {
  background: var(--surface-muted, rgba(127, 127, 127, 0.08));
}

.expert-item--active {
  border-color: var(--accent, #3b82f6);
  background: var(--surface-muted, rgba(127, 127, 127, 0.08));
}

.expert-item--archived .expert-item__name {
  opacity: 0.65;
}

.expert-item__name {
  font-weight: 600;
}

.expert-item__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.expert-item__meta small {
  color: var(--text-secondary);
}

.detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.detail-head h3 {
  margin: 0;
}

.detail-block {
  margin-bottom: var(--space-5, var(--space-4));
}

.detail-block h4 {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
}

.wrap-cell {
  max-width: 360px;
  white-space: normal;
  word-break: break-word;
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

.muted-text {
  color: var(--text-secondary);
}

.forge-detail-link {
  color: var(--accent, #3b82f6);
  text-decoration: none;
}

.forge-detail-link:hover {
  text-decoration: underline;
}
</style>
