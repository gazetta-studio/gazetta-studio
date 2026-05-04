<script setup lang="ts">
/**
 * Save-time validation banner — shown at the top of the editor when the most
 * recent save returned 409 VALIDATION_FAILED. Lists the issues with severity
 * icon + author-facing message + (when available) the content path so the
 * author can navigate.
 *
 * Per design-validation.md "Banner (save-time integrity)": high visual weight,
 * red, dismissible. Stays pinned until the next successful save or explicit
 * dismiss; the save button stays disabled while errors are present (the
 * disabling lives in CmsToolbar via editing.hasPendingEdits + this banner's
 * presence — Cut 1 ships banner-presence as the visible signal, save button
 * disabling is wired in Cut 2 alongside the Site Health drawer).
 */
import { computed } from 'vue'
import Button from 'primevue/button'
import { useValidationIssuesStore } from '../stores/validationIssues.js'

const validation = useValidationIssuesStore()

const errorCount = computed(() => validation.errorCount)
const otherCount = computed(() => validation.issues.length - validation.errorCount)

const headline = computed(() => {
  const errs = errorCount.value
  if (errs > 0) {
    return `${errs} validation ${errs === 1 ? 'error' : 'errors'} blocked the save`
  }
  return `${validation.issues.length} validation issues`
})

function dismiss() {
  validation.clear()
}

function severityIcon(severity: 'error' | 'warn' | 'info'): string {
  if (severity === 'error') return 'pi pi-times-circle'
  if (severity === 'warn') return 'pi pi-exclamation-triangle'
  return 'pi pi-info-circle'
}
</script>

<template>
  <div v-if="validation.hasIssues" class="validation-banner" role="alert" data-testid="validation-banner">
    <div class="banner-header">
      <i class="pi pi-times-circle banner-icon" aria-hidden="true" />
      <span class="banner-title">{{ headline }}</span>
      <span v-if="otherCount > 0" class="banner-aside">+{{ otherCount }} non-blocking</span>
      <Button
        icon="pi pi-times"
        text
        rounded
        size="small"
        severity="secondary"
        class="banner-dismiss"
        :aria-label="'Dismiss validation banner'"
        data-testid="validation-banner-dismiss"
        @click="dismiss"
      />
    </div>
    <ul class="banner-issues">
      <li
        v-for="(issue, idx) in validation.issues"
        :key="`${issue.validator}-${idx}`"
        :class="['issue', `issue-${issue.severity}`]"
        :data-testid="`validation-issue-${issue.validator}`">
        <i :class="[severityIcon(issue.severity), 'issue-icon']" aria-hidden="true" />
        <div class="issue-body">
          <span class="issue-message">{{ issue.message }}</span>
          <span v-if="issue.contentPath" class="issue-path">at <code>{{ issue.contentPath }}</code></span>
          <span class="issue-validator">[{{ issue.validator }}]</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.validation-banner {
  background: var(--color-danger-bg);
  color: var(--color-danger-fg);
  border: 1px solid var(--color-danger-fg);
  border-radius: var(--p-border-radius-md);
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
}
.banner-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
}
.banner-icon {
  font-size: 1.1rem;
}
.banner-title {
  flex: 1;
}
.banner-aside {
  font-weight: 400;
  font-size: 0.8125rem;
  opacity: 0.8;
}
.banner-dismiss {
  margin-inline-start: auto;
}
.banner-issues {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.issue {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.25rem 0;
  font-size: 0.875rem;
}
.issue-icon {
  margin-top: 0.125rem;
  flex-shrink: 0;
}
.issue-body {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
}
.issue-message {
  flex: 1 0 auto;
}
.issue-path {
  font-size: 0.8125rem;
  opacity: 0.85;
}
.issue-path code {
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
}
.issue-validator {
  font-size: 0.75rem;
  opacity: 0.6;
  font-family: ui-monospace, monospace;
}
</style>
