/**
 * Active locale — tracks which locale the author is editing.
 *
 * URL is source of truth: ?locale=fr in the query param. No locale =
 * default locale. The router guard syncs URL → store, same pattern as
 * ?target=.
 *
 * The locale is passed to api.getPage/getFragment calls so the server
 * returns the locale-specific manifest.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSiteStore } from './site.js'

export const useLocaleStore = defineStore('locale', () => {
  const activeLocale = ref<string | null>(null)

  /** The site's configured locales, or null if i18n is not enabled. */
  const siteLocales = computed(() => {
    const site = useSiteStore()
    return site.manifest?.locales?.supported ?? null
  })

  /** Whether i18n is enabled for this site. */
  const isEnabled = computed(() => siteLocales.value !== null && siteLocales.value.length > 1)

  /** The default locale (locales.default, or first in supported list). */
  const defaultLocale = computed(() => {
    const site = useSiteStore()
    if (site.manifest?.locales?.default) return site.manifest.locales.default
    return siteLocales.value?.[0] ?? null
  })

  /** Set the active locale. null = default locale. */
  function setLocale(locale: string | null) {
    activeLocale.value = locale
  }

  /** The effective locale for API calls — null means default (no ?locale= param). */
  const effectiveLocale = computed(() => {
    if (!isEnabled.value) return null
    if (!activeLocale.value) return null
    if (activeLocale.value === defaultLocale.value) return null
    return activeLocale.value
  })

  return {
    activeLocale,
    siteLocales,
    isEnabled,
    defaultLocale,
    effectiveLocale,
    setLocale,
  }
})
