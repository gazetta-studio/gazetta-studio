import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, type PageDetail, type FragmentDetail, type PageSummary } from '../api/client.js'
import { useToastStore } from './toast.js'
import { usePreviewStore } from './preview.js'
import { useSiteStore } from './site.js'
import { useLocaleStore } from './locale.js'

export type Selection =
  | { type: 'page'; name: string; detail: PageDetail }
  | { type: 'fragment'; name: string; detail: FragmentDetail }

export const useSelectionStore = defineStore('selection', () => {
  const toast = useToastStore()

  const selection = ref<Selection | null>(null)
  const fragmentHostPage = ref<PageSummary | null>(null)
  let selectController: AbortController | null = null

  // Convenience accessors
  const type = computed(() => selection.value?.type ?? null)
  const name = computed(() => selection.value?.name ?? null)
  const detail = computed(() => selection.value?.detail ?? null)

  /** Pages with static routes (no :params) — usable as fragment preview hosts */
  const staticPages = computed(() => useSiteStore().pages.filter(p => !p.route.includes(':')))

  const previewRoute = computed(() => {
    if (selection.value?.type === 'page') return selection.value.detail.route
    if (selection.value?.type === 'fragment') {
      if (fragmentHostPage.value) return fragmentHostPage.value.route
      return `/@${selection.value.name}`
    }
    return null
  })

  function resolveDefaultHostPage() {
    const pages = staticPages.value
    fragmentHostPage.value = pages.find(p => p.route === '/') ?? pages[0] ?? null
  }

  function setFragmentHostPage(pageName: string) {
    const page = staticPages.value.find(p => p.name === pageName)
    if (page) {
      fragmentHostPage.value = page
      usePreviewStore().invalidate()
    }
  }

  async function selectPage(pageName: string) {
    selectController?.abort()
    selectController = new AbortController()
    const { signal } = selectController
    try {
      const locale = useLocaleStore().effectiveLocale ?? undefined
      const detail = await api.getPage(pageName, { signal, locale })
      selection.value = { type: 'page', name: pageName, detail }
      fragmentHostPage.value = null
      usePreviewStore().invalidate()
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      toast.showError(err, `Failed to load page "${pageName}"`)
    }
  }

  async function selectFragment(fragName: string) {
    selectController?.abort()
    selectController = new AbortController()
    const { signal } = selectController
    try {
      const locale = useLocaleStore().effectiveLocale ?? undefined
      const detail = await api.getFragment(fragName, { signal, locale })
      selection.value = { type: 'fragment', name: fragName, detail }
      if (!fragmentHostPage.value) resolveDefaultHostPage()
      usePreviewStore().invalidate()
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      toast.showError(err, `Failed to load fragment "${fragName}"`)
    }
  }

  /** Refresh the current selection's detail from the server */
  async function reload() {
    if (!selection.value) return
    try {
      if (selection.value.type === 'page') {
        const detail = await api.getPage(selection.value.name)
        selection.value = { type: 'page', name: selection.value.name, detail }
      } else {
        const detail = await api.getFragment(selection.value.name)
        selection.value = { type: 'fragment', name: selection.value.name, detail }
      }
    } catch (err) {
      toast.showError(err, 'Failed to reload')
    }
  }

  return {
    selection,
    type,
    name,
    detail,
    previewRoute,
    fragmentHostPage,
    staticPages,
    selectPage,
    selectFragment,
    setFragmentHostPage,
    reload,
  }
})
