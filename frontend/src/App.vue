<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, RouterView } from 'vue-router'
import Sidebar from '@/components/Sidebar.vue'

const route = useRoute()
const showSidebar = computed(() => route.path !== '/auth')
</script>

<template>
  <div class="h-screen flex flex-col bg-gray-50 overflow-hidden">
    <div class="flex-1 flex min-h-0">
      <Sidebar v-if="showSidebar" />
      <main class="flex-1 flex flex-col min-w-0 overflow-hidden">
        <RouterView />
      </main>
    </div>
  </div>
</template>
