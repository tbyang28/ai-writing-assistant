import type { Directive } from 'vue'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * v-reveal —— 进入视口时淡入上移（配合 main.css 的 .reveal-init / .reveal-on）。
 * 用法：v-reveal 直接生效；v-reveal="'120ms'" 追加过渡延迟做交错。
 * reduced-motion 下元素保持最终可读态，不做位移。
 */
export const vReveal: Directive<HTMLElement, string | undefined> = {
  mounted(el, binding) {
    const delay = binding.value
    if (delay) el.style.transitionDelay = delay

    if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
      el.classList.add('reveal-on')
      return
    }

    el.classList.add('reveal-init')
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('reveal-on')
            io.disconnect()
            break
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    )
    io.observe(el)
  },
}
