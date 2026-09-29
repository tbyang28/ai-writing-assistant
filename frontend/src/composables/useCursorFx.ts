import type { Directive } from 'vue'

export function cursorFxEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  // 触屏没有悬停光标，跳过所有跟随类动效
  if (!window.matchMedia('(pointer: fine)').matches) return false
  return true
}

/**
 * v-spotlight —— 卡片内部光斑跟随光标（配合 main.css 的 .spot-target::before）
 */
export const vSpotlight: Directive<HTMLElement> = {
  mounted(el) {
    if (!cursorFxEnabled()) return
    el.classList.add('spot-target')
    const move = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${e.clientX - r.left}px`)
      el.style.setProperty('--my', `${e.clientY - r.top}px`)
    }
    el.addEventListener('mousemove', move)
    ;(el as any)._vSpotlightOff = () => el.removeEventListener('mousemove', move)
  },
  unmounted(el) {
    ;(el as any)._vSpotlightOff?.()
  },
}

/**
 * v-magnetic —— 光标靠近时元素被轻微吸附（放在入口动画元素外层，避免与 fill 动画抢 transform）
 * v-magnetic="0.25" 可自定义吸附强度
 */
export const vMagnetic: Directive<HTMLElement, number | undefined> = {
  mounted(el, binding) {
    if (!cursorFxEnabled()) return
    const strength = binding.value ?? 0.2
    el.style.transition = 'transform 0.18s ease-out'
    el.style.willChange = 'transform'

    const move = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0) return
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      const range = Math.max(r.width, r.height) / 2 + 56
      el.style.transform = Math.hypot(dx, dy) < range
        ? `translate3d(${dx * strength}px, ${dy * strength}px, 0)`
        : ''
    }
    window.addEventListener('mousemove', move, { passive: true })
    ;(el as any)._vMagneticOff = () => window.removeEventListener('mousemove', move)
  },
  unmounted(el) {
    ;(el as any)._vMagneticOff?.()
  },
}
