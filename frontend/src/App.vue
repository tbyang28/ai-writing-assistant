<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, RouterView } from 'vue-router'
import Sidebar from '@/components/Sidebar.vue'
import { useThemeStore } from '@/stores/theme'

const route = useRoute()
const themeStore = useThemeStore()
const showSidebar = computed(() => route.path !== '/auth')

onMounted(() => {
  themeStore.init()
})
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden" :style="{ backgroundColor: 'var(--bg-page)', color: 'var(--text-primary)' }">
    <div class="flex-1 flex min-h-0">
      <Sidebar v-if="showSidebar" />
      <main class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <RouterView />
      </main>
    </div>
  </div>
</template>
