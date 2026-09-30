<script setup lang="ts">
import type { PublicBook } from '@/stores/community'
defineProps<{ book: PublicBook }>()
</script>
<template>
  <article class="card p-5 flex gap-4 h-full">
    <router-link :to="`/community/books/${book.id}`" class="shrink-0 w-20 h-28 rounded-lg overflow-hidden flex items-center justify-center text-center p-2 font-serif border" :style="{ background: 'var(--brand-softer)', borderColor: 'var(--border-clr)' }" :aria-label="`阅读${book.title}`">
      <img v-if="book.cover" :src="book.cover" alt="" class="w-full h-full object-cover" loading="lazy" />
      <span v-else class="text-sm leading-6 line-clamp-4">{{ book.title }}</span>
    </router-link>
    <div class="min-w-0 flex-1">
      <router-link :to="`/community/books/${book.id}`" class="font-serif text-xl font-semibold hover:text-brand break-words">{{ book.title }}</router-link>
      <router-link :to="`/community/users/${book.author.id}`" class="block text-sm mt-1 hover:underline" :style="{ color: 'var(--text-secondary)' }">{{ book.author.name || book.author.username }}</router-link>
      <p class="text-sm leading-6 line-clamp-2 mt-2" :style="{ color: 'var(--text-secondary)' }">{{ book.description || '作者还没有填写简介。' }}</p>
      <div class="flex flex-wrap gap-2 mt-3 text-xs" :style="{ color: 'var(--text-secondary)' }"><span v-if="book.genre">{{ book.genre }}</span><span>{{ book.status === 'FINISHED' ? '已完结' : '连载中' }}</span><span>{{ book.like_count }} 赞</span><span>{{ book.word_count.toLocaleString() }} 字</span></div>
      <div v-if="book.tags.length" class="flex flex-wrap gap-1.5 mt-2"><span v-for="tag in book.tags" :key="tag" class="rounded-full px-2 py-1 text-xs" :style="{ background: 'var(--surface-secondary)', color: 'var(--text-secondary)' }">#{{ tag }}</span></div>
      <slot />
    </div>
  </article>
</template>
