<template>
  <UiTableFrame density="compact">
    <thead>
      <tr>
        <th>Agent</th>
        <th>Skill 名称</th>
        <th>简介</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="agent in agents" :key="agent.agentId">
        <td>
          <div class="agent-cell">
            <span>{{ agent.agentId }}</span>
            <small v-if="agent.alias && agent.alias !== agent.agentId">{{ agent.alias }}</small>
          </div>
        </td>
        <td>
          <code v-if="agent.skillName" class="skill-name">{{ agent.skillName }}</code>
          <span
            v-else
            class="muted-text"
            title="该 agent 尚未发布接入 guidance，导出会返回具体原因"
          >未发布 guidance</span>
        </td>
        <td>
          <span class="summary-text" :title="agent.summary">{{ agent.summary || "—" }}</span>
        </td>
        <td>
          <UiButton
            variant="secondary"
            size="xs"
            :loading="exportingAgentId === agent.agentId"
            :disabled="exportingAgentId !== null && exportingAgentId !== agent.agentId"
            :title="`导出 ${agent.skillName ?? `vcp-${agent.agentId.toLowerCase()}`} 接入 skill（zip）`"
            @click="emit('export', agent)"
          >
            <template #leading>
              <span class="material-symbols-outlined">download</span>
            </template>
            导出 skill
          </UiButton>
        </td>
      </tr>
    </tbody>
  </UiTableFrame>
  <UiEmptyState
    v-if="agents.length === 0"
    title="暂无可导出的 Agent"
    description="agent 清单来自 agent_map.json；主进程完成 Gateway 初始化后此处会列出可导出的 agent。"
  >
    <template #icon>
      <span class="material-symbols-outlined">cloud_off</span>
    </template>
  </UiEmptyState>
</template>

<script setup lang="ts">
import type { GatewayAgentOption } from "@/api/agentGateway";
import UiButton from "@/components/ui/UiButton.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import UiTableFrame from "@/components/ui/UiTableFrame.vue";

defineProps<{
  agents: GatewayAgentOption[];
  exportingAgentId: string | null;
}>();

const emit = defineEmits<{
  export: [agent: GatewayAgentOption];
}>();
</script>

<style scoped>
.agent-cell {
  display: grid;
  gap: 2px;
}

.agent-cell small {
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
}

.skill-name {
  font-family: "Consolas", "Monaco", monospace;
  font-size: var(--font-size-helper);
}

.summary-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--secondary-text);
  font-size: var(--font-size-helper);
}

.muted-text {
  color: var(--secondary-text);
}
</style>
