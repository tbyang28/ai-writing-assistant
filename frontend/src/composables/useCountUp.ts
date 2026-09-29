import { onScopeDispose, ref, watch, type Ref } from 'vue'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 数字滚动动画（rAF 驱动，cubic 缓出）。
 * source 变化时从当前显示值平滑滚到新值；reduced-motion 下直接跳到终值。
 */
export function useCountUp(source: () => number, duration = 650): Ref<number> {
  const display = ref(0)
  let raf = 0
  let from = 0
  let startTs = 0

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

  function animateTo(target: number) {
    cancelAnimationFrame(raf)
    if (prefersReducedMotion() || duration <= 0) {
      display.value = Math.round(target)
      return
    }
    from = display.value
    startTs = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - startTs) / duration)
      display.value = Math.round(from + (target - from) * easeOutCubic(t))
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  watch(source, (val) => animateTo(val || 0), { immediate: true })
  onScopeDispose(() => cancelAnimationFrame(raf))
  return display
}
