import { CircleX, Info, TriangleAlert } from '@lucide/vue'
import type { Component } from 'vue'

/** The icon for a validation issue's severity, the same on every screen that lists issues. */
export const ISSUE_SEVERITY_ICON: Record<'error' | 'warn' | 'info', Component> = {
  error: CircleX,
  warn: TriangleAlert,
  info: Info,
}
