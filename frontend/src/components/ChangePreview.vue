<script setup lang="ts">
import { computed } from 'vue'
import { buildTextDiff } from '@/utils/textDiff'

const props = defineProps<{
  original: string
  revised: string
  label: string
}>()

defineEmits<{
  accept: []
  reject: []
}>()

const segments = computed(() => buildTextDiff(props.original, props.revised))
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5"
      :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)' }">
      <div class="min-w-0">
        <div class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">{{ label }}</div>
        <div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">预览变更，接受后才会写入正文</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" @click="$emit('reject')" class="btn-secondary text-xs px-2.5 py-1">拒绝</button>
        <button type="button" @click="$emit('accept')" class="btn-primary text-xs px-2.5 py-1">接受变更</button>
      </div>
    </div>

    <div class="rounded-xl border px-5 py-5 text-[17px] leading-loose font-serif whitespace-pre-wrap break-words"
      :style="{ borderColor: 'var(--border-clr)', backgroundColor: 'var(--surface-secondary)', color: 'var(--text-primary)' }">
      <template v-for="(segment, index) in segments" :key="`${segment.type}-${index}`">
        <span v-if="segment.type === 'equal'">{{ segment.text }}</span>
        <del v-else-if="segment.type === 'delete'"
          class="rounded-sm px-0.5 decoration-2"
          :style="{ backgroundColor: '#f3dcd5', color: '#a0432c', textDecorationColor: '#a0432c' }">{{ segment.text }}</del>
        <ins v-else
          class="rounded-sm px-0.5 no-underline"
          :style="{ backgroundColor: '#dfe8dc', color: '#3e6b48' }">{{ segment.text }}</ins>
      </template>
    </div>
  </div>
</template>
