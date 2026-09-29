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

// 暖陶土色系 —— 与 Claude 风格一致，在米纸/暖炭两种底色上都有足够对比度
const rolePalettes = [
  { keys: ['主角', '男主', '女主', 'protagonist'], color: '#D97757', group: '核心' },
  { keys: ['反派', '敌人', 'boss', 'villain'], color: '#C25344', group: '对立' },
  { keys: ['师父', '导师', 'mentor'], color: '#64829F', group: '引导' },
  { keys: ['配角', '朋友', '伙伴', 'ally'], color: '#448A6A', group: '同盟' },
]

function classifyRole(role?: string) {
  const normalized = (role || '').toLowerCase()
  const match = rolePalettes.find((item) => item.keys.some((key) => normalized.includes(key.toLowerCase())))
  return match || { color: '#C9974F', group: '其他' }
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
    ally: '#448A6A',
    rival: '#C25344',
    mentor: '#64829F',
    complex: '#C9974F',
  }
  return colors[type]
}
</script>

<template>
  <div class="h-full overflow-hidden" :style="{ backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }">
    <div v-if="characters.length < 2" class="h-full flex items-center justify-center px-6">
      <div class="max-w-md text-center">
        <div class="mx-auto mb-5 h-20 w-20 rounded-full flex items-center justify-center"
          :style="{ backgroundColor: 'var(--brand-soft)', color: 'var(--brand-hover)' }">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" /><circle cx="18" cy="18" r="3" />
            <path d="M8.5 8.5l7 7M15.5 8.5l-7 7M9 6h6M9 18h6M6 9v6M18 9v6" />
          </svg>
        </div>
        <h3 class="font-serif text-xl font-semibold" :style="{ color: 'var(--text-primary)' }">角色还不够生成关系图</h3>
        <p class="mt-2 text-sm" :style="{ color: 'var(--text-muted)' }">至少创建 2 个角色后，这里会自动生成可展示的人物网络。</p>
      </div>
    </div>

    <div v-else class="h-full grid grid-rows-[auto_1fr]">
      <div class="border-b px-6 py-4" :style="{ borderBottomColor: 'var(--border-clr)' }">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div class="eyebrow">Character Network</div>
            <h2 class="mt-1.5 font-serif text-2xl font-semibold" :style="{ color: 'var(--text-primary)' }">{{ bookTitle || '角色关系图' }}</h2>
          </div>
          <div class="grid grid-cols-4 gap-2.5 text-center">
            <div v-for="stat in [
              { label: '角色', value: nodes.length },
              { label: '关系', value: edges.length },
              { label: '阵营', value: groupCount },
              { label: '焦点', value: selectedNode?.name?.slice(0, 4) },
            ]" :key="stat.label"
              class="rounded-xl border px-4 py-2"
              :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }">
              <div class="font-serif text-lg font-semibold truncate" :style="{ color: 'var(--text-primary)' }">{{ stat.value }}</div>
              <div class="text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ stat.label }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid min-h-0 grid-cols-[1fr_280px]">
        <div class="relative overflow-hidden" :style="{ backgroundColor: 'var(--bg-page)' }">
          <svg viewBox="0 0 860 520" class="absolute inset-0 h-full w-full">
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
                :stroke-dasharray="edge.type === 'complex' ? '7 7' : undefined"
                stroke-linecap="round"
                opacity="0.55"
              />
              <text
                v-for="edge in edges.slice(0, 8)"
                :key="`${edge.id}-label`"
                :x="(edge.source.x + edge.target.x) / 2"
                :y="(edge.source.y + edge.target.y) / 2 - 7"
                text-anchor="middle"
                class="text-[10px]"
                :style="{ fill: 'var(--text-muted)' }"
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
                  :r="node.id === selectedNode?.id ? 38 : node.group === '核心' ? 33 : 27"
                  :fill="node.color"
                  opacity="0.15"
                />
                <circle
                  :cx="node.x"
                  :cy="node.y"
                  :r="node.group === '核心' ? 27 : 23"
                  :fill="node.color"
                  :stroke="'var(--surface)'"
                  :stroke-width="node.id === selectedNode?.id ? 3.5 : 2"
                />
                <text
                  :x="node.x"
                  :y="node.y + 5"
                  text-anchor="middle"
                  class="select-none text-sm font-semibold"
                  fill="#fffdf8"
                >
                  {{ node.name.slice(0, 2) }}
                </text>
                <text
                  :x="node.x"
                  :y="node.y + 43"
                  text-anchor="middle"
                  class="select-none text-xs"
                  :style="{ fill: 'var(--text-secondary)' }"
                >
                  {{ node.name }}
                </text>
              </g>
            </g>
          </svg>

          <div class="absolute bottom-5 left-6 flex flex-wrap gap-2">
            <span class="rounded-full px-3 py-1 text-xs font-medium"
              :style="{ backgroundColor: '#dde8d9', color: '#3e6b48' }">同盟 {{ relationStats.ally }}</span>
            <span class="rounded-full px-3 py-1 text-xs font-medium"
              :style="{ backgroundColor: '#f3dcd5', color: '#a0432c' }">敌对 {{ relationStats.rival }}</span>
            <span class="rounded-full px-3 py-1 text-xs font-medium"
              :style="{ backgroundColor: '#dce4ec', color: '#4a6785' }">引导 {{ relationStats.mentor }}</span>
            <span class="rounded-full px-3 py-1 text-xs font-medium"
              :style="{ backgroundColor: '#f0e6d2', color: '#8f6a2b' }">复杂 {{ relationStats.complex }}</span>
          </div>
        </div>

        <aside class="border-l p-5 overflow-y-auto" :style="{ borderLeftColor: 'var(--border-clr)', backgroundColor: 'var(--surface)' }">
          <div v-if="selectedNode" class="space-y-5">
            <div>
              <div class="mb-3 h-16 w-16 rounded-2xl flex items-center justify-center text-2xl font-serif font-semibold text-white"
                :style="{ backgroundColor: selectedNode.color, color: '#fffdf8', boxShadow: 'var(--shadow-soft)' }">
                {{ selectedNode.name.slice(0, 1) }}
              </div>
              <h3 class="font-serif text-xl font-semibold" :style="{ color: 'var(--text-primary)' }">{{ selectedNode.name }}</h3>
              <p class="mt-1 text-sm font-medium" :style="{ color: 'var(--brand-hover)' }">{{ selectedNode.role || selectedNode.group }}</p>
            </div>

            <div>
              <div class="text-[11px] uppercase font-semibold" :style="{ letterSpacing: '0.14em', color: 'var(--text-muted)' }">人物设定</div>
              <p class="mt-2 text-sm leading-6" :style="{ color: 'var(--text-secondary)' }">
                {{ selectedNode.bio || '暂无人物简介，可以在左侧角色列表中补充背景、目标和性格。' }}
              </p>
            </div>

            <div>
              <div class="text-[11px] uppercase font-semibold" :style="{ letterSpacing: '0.14em', color: 'var(--text-muted)' }">关系摘要</div>
              <div class="mt-3 space-y-2">
                <div
                  v-for="edge in edges.filter((item) => item.source.id === selectedNode?.id || item.target.id === selectedNode?.id)"
                  :key="edge.id"
                  class="rounded-xl border px-3 py-2"
                  :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-sm" :style="{ color: 'var(--text-primary)' }">
                      {{ edge.source.id === selectedNode.id ? edge.target.name : edge.source.name }}
                    </span>
                    <span class="text-xs font-medium" :style="{ color: edgeColor(edge.type) }">{{ edge.label }}</span>
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
