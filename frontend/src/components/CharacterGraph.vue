<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Character, CharacterRelation } from '@/stores/book'

type GraphNode = Character & {
  x: number
  y: number
  color: string
  group: string
}

type GraphEdge = {
  id: string
  source: GraphNode
  target: GraphNode
  type: 'ally' | 'rival' | 'mentor' | 'complex'
  label: string
  strength: number
}

const props = defineProps<{
  characters: Character[]
  relations?: CharacterRelation[]
  bookTitle?: string
}>()

const selectedNodeId = ref<string | null>(null)

const rolePalettes = [
  { keys: ['主角', '男主', '女主', 'protagonist'], color: '#2563eb', group: '核心' },
  { keys: ['反派', '敌人', 'boss', 'villain'], color: '#dc2626', group: '对立' },
  { keys: ['师父', '导师', 'mentor'], color: '#7c3aed', group: '引导' },
  { keys: ['配角', '朋友', '伙伴', 'ally'], color: '#059669', group: '同盟' },
]

function classifyRole(role?: string) {
  const normalized = (role || '').toLowerCase()
  const match = rolePalettes.find((item) => item.keys.some((key) => normalized.includes(key.toLowerCase())))
  return match || { color: '#f59e0b', group: '其他' }
}

const nodes = computed<GraphNode[]>(() => {
  const width = 860
  const height = 520
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(250, 110 + props.characters.length * 18)

  return props.characters.map((character, index) => {
    const palette = classifyRole(character.role)
    if (index === 0) {
      return { ...character, x: centerX, y: centerY, color: palette.color, group: '核心' }
    }

    const angle = ((index - 1) / Math.max(1, props.characters.length - 1)) * Math.PI * 2 - Math.PI / 2
    return {
      ...character,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      color: palette.color,
      group: palette.group,
    }
  })
})

const edges = computed<GraphEdge[]>(() => {
  const result: GraphEdge[] = []
  const list = nodes.value
  if (list.length < 2) return result

  const nodeMap = new Map(list.map((node) => [node.id, node]))
  if (props.relations?.length) {
    props.relations.forEach((relation) => {
      const source = nodeMap.get(relation.source_character_id)
      const target = nodeMap.get(relation.target_character_id)
      if (!source || !target) return
      const type = normalizeRelationType(relation.relation_type)
      result.push({
        id: relation.id,
        source,
        target,
        type,
        label: relation.description || relationLabel(type),
        strength: Math.max(1, Math.min(relation.strength || 2, 5)),
      })
    })
    return result
  }

  const core = list[0]
  list.slice(1).forEach((node, index) => {
    const type: GraphEdge['type'] = node.group === '对立'
      ? 'rival'
      : node.group === '引导'
        ? 'mentor'
        : index % 3 === 0
          ? 'complex'
          : 'ally'
    result.push({
      id: `${core.id}-${node.id}`,
      source: core,
      target: node,
      type,
      label: relationLabel(type),
      strength: 2 + (index % 3),
    })
  })

  for (let index = 1; index < list.length - 1; index += 1) {
    if (index % 2 === 1) {
      result.push({
        id: `${list[index].id}-${list[index + 1].id}`,
        source: list[index],
        target: list[index + 1],
        type: index % 4 === 1 ? 'complex' : 'ally',
        label: index % 4 === 1 ? '潜在冲突' : '剧情关联',
        strength: 1,
      })
    }
  }

  return result
})

const selectedNode = computed(() => {
  return nodes.value.find((node) => node.id === selectedNodeId.value) || nodes.value[0] || null
})

const groupCount = computed(() => {
  return new Set(nodes.value.map((node) => node.group)).size
})

const relationStats = computed(() => {
  return {
    ally: edges.value.filter((edge) => edge.type === 'ally').length,
    rival: edges.value.filter((edge) => edge.type === 'rival').length,
    mentor: edges.value.filter((edge) => edge.type === 'mentor').length,
    complex: edges.value.filter((edge) => edge.type === 'complex').length,
  }
})

function relationLabel(type: GraphEdge['type']) {
  const labels = {
    ally: '同盟',
    rival: '敌对',
    mentor: '引导',
    complex: '复杂',
  }
  return labels[type]
}

function normalizeRelationType(type: string): GraphEdge['type'] {
  if (type === 'rival' || type === 'mentor' || type === 'complex') return type
  return 'ally'
}

function edgeColor(type: GraphEdge['type']) {
  const colors = {
    ally: '#10b981',
    rival: '#ef4444',
    mentor: '#3b82f6',
    complex: '#a855f7',
  }
  return colors[type]
}
</script>

<template>
  <div class="h-full overflow-hidden bg-[#0b1020] text-white">
    <div v-if="characters.length < 2" class="h-full flex items-center justify-center px-6">
      <div class="max-w-md text-center">
        <div class="mx-auto mb-5 h-20 w-20 rounded-full bg-white/10 flex items-center justify-center text-3xl">关系</div>
        <h3 class="text-xl font-semibold">角色还不够生成关系图</h3>
        <p class="mt-2 text-sm text-slate-300">至少创建 2 个角色后，这里会自动生成可展示的人物网络。</p>
      </div>
    </div>

    <div v-else class="h-full grid grid-rows-[auto_1fr]">
      <div class="border-b border-white/10 px-6 py-4">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-cyan-300">Character Network</div>
            <h2 class="mt-1 text-2xl font-semibold">{{ bookTitle || '角色关系图' }}</h2>
          </div>
          <div class="grid grid-cols-4 gap-3 text-center">
            <div class="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <div class="text-lg font-semibold">{{ nodes.length }}</div>
              <div class="text-xs text-slate-300">角色</div>
            </div>
            <div class="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <div class="text-lg font-semibold">{{ edges.length }}</div>
              <div class="text-xs text-slate-300">关系</div>
            </div>
            <div class="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <div class="text-lg font-semibold">{{ groupCount }}</div>
              <div class="text-xs text-slate-300">阵营</div>
            </div>
            <div class="rounded-lg border border-white/10 bg-white/5 px-4 py-2">
              <div class="text-lg font-semibold">{{ selectedNode?.name?.slice(0, 4) }}</div>
              <div class="text-xs text-slate-300">焦点</div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid min-h-0 grid-cols-[1fr_280px]">
        <div class="relative overflow-hidden">
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(34,211,238,0.18),transparent_34%),radial-gradient(circle_at_22%_70%,rgba(168,85,247,0.18),transparent_30%)]"></div>
          <svg viewBox="0 0 860 520" class="relative h-full w-full">
            <defs>
              <filter id="nodeGlow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <g>
              <line
                v-for="edge in edges"
                :key="edge.id"
                :x1="edge.source.x"
                :y1="edge.source.y"
                :x2="edge.target.x"
                :y2="edge.target.y"
                :stroke="edgeColor(edge.type)"
                :stroke-width="edge.strength"
                :stroke-dasharray="edge.type === 'complex' ? '8 8' : undefined"
                stroke-linecap="round"
                opacity="0.68"
              />
              <text
                v-for="edge in edges.slice(0, 8)"
                :key="`${edge.id}-label`"
                :x="(edge.source.x + edge.target.x) / 2"
                :y="(edge.source.y + edge.target.y) / 2 - 7"
                text-anchor="middle"
                class="fill-slate-200 text-[10px]"
                opacity="0.82"
              >
                {{ edge.label }}
              </text>
            </g>

            <g>
              <g
                v-for="node in nodes"
                :key="node.id"
                class="cursor-pointer transition-opacity"
                @click="selectedNodeId = node.id"
              >
                <circle
                  :cx="node.x"
                  :cy="node.y"
                  :r="node.id === selectedNode?.id ? 38 : node.group === '核心' ? 34 : 28"
                  :fill="node.color"
                  opacity="0.22"
                  filter="url(#nodeGlow)"
                />
                <circle
                  :cx="node.x"
                  :cy="node.y"
                  :r="node.group === '核心' ? 27 : 23"
                  :fill="node.color"
                  stroke="rgba(255,255,255,0.86)"
                  :stroke-width="node.id === selectedNode?.id ? 3 : 1.5"
                />
                <text
                  :x="node.x"
                  :y="node.y + 5"
                  text-anchor="middle"
                  class="select-none fill-white text-sm font-semibold"
                >
                  {{ node.name.slice(0, 2) }}
                </text>
                <text
                  :x="node.x"
                  :y="node.y + 43"
                  text-anchor="middle"
                  class="select-none fill-slate-200 text-xs"
                >
                  {{ node.name }}
                </text>
              </g>
            </g>
          </svg>

          <div class="absolute bottom-5 left-6 flex flex-wrap gap-2">
            <span class="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">同盟 {{ relationStats.ally }}</span>
            <span class="rounded-full border border-red-400/30 bg-red-400/10 px-3 py-1 text-xs text-red-200">敌对 {{ relationStats.rival }}</span>
            <span class="rounded-full border border-blue-400/30 bg-blue-400/10 px-3 py-1 text-xs text-blue-200">引导 {{ relationStats.mentor }}</span>
            <span class="rounded-full border border-purple-400/30 bg-purple-400/10 px-3 py-1 text-xs text-purple-200">复杂 {{ relationStats.complex }}</span>
          </div>
        </div>

        <aside class="border-l border-white/10 bg-white/[0.06] p-5">
          <div v-if="selectedNode" class="space-y-5">
            <div>
              <div class="mb-3 h-16 w-16 rounded-2xl flex items-center justify-center text-2xl font-semibold shadow-lg"
                :style="{ backgroundColor: selectedNode.color }">
                {{ selectedNode.name.slice(0, 1) }}
              </div>
              <h3 class="text-xl font-semibold">{{ selectedNode.name }}</h3>
              <p class="mt-1 text-sm text-cyan-200">{{ selectedNode.role || selectedNode.group }}</p>
            </div>

            <div>
              <div class="text-xs uppercase tracking-[0.16em] text-slate-400">人物设定</div>
              <p class="mt-2 text-sm leading-6 text-slate-200">
                {{ selectedNode.bio || '暂无人物简介，可以在左侧角色列表中补充背景、目标和性格。' }}
              </p>
            </div>

            <div>
              <div class="text-xs uppercase tracking-[0.16em] text-slate-400">关系摘要</div>
              <div class="mt-3 space-y-2">
                <div
                  v-for="edge in edges.filter((item) => item.source.id === selectedNode?.id || item.target.id === selectedNode?.id)"
                  :key="edge.id"
                  class="rounded-lg border border-white/10 bg-black/20 px-3 py-2"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-sm">
                      {{ edge.source.id === selectedNode.id ? edge.target.name : edge.source.name }}
                    </span>
                    <span class="text-xs" :style="{ color: edgeColor(edge.type) }">{{ edge.label }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>
