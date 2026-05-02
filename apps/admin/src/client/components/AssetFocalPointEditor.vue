<script setup lang="ts">
/**
 * Focal point editor — interactive crosshair on an image preview, with
 * live aspect-ratio thumbnails alongside.
 *
 * UX shape (informed by CMS competitive research):
 *   - Click anywhere on the image to place the focal point (Strapi 5)
 *   - Drag the marker to fine-tune (WordPress Gutenberg FocalPointPicker)
 *   - Hover-preview marker — semi-transparent dot follows cursor before
 *     commit, solid on commit (Strapi 5)
 *   - Aspect-ratio preview thumbnails: 1:1, 16:9, 4:5, 9:16 — each
 *     shows what the crop would look like at that ratio with the
 *     current focal point (Sanity Studio's `hotspot.previews`)
 *   - Live x/y badge in 0–100 percentage (Strapi)
 *   - Reset to center (Strapi, Payload)
 *
 * Three-state model:
 *   - modelValue: { x, y }     → set focal point
 *   - modelValue: null         → use center as default (no preference set)
 *   - on reset: emit `null`    → clears the manifest field
 *
 * Storage shape is normalized 0–1 floats (matching the manifest's
 * `focalPoint?: { x, y }`). The 0–100 percentage is display-only.
 *
 * Pure presentation — emits `update:modelValue` on commit; the parent
 * persists via the asset metadata PATCH endpoint.
 */
import { computed, ref } from 'vue'
import Button from 'primevue/button'

const props = defineProps<{
  /** Current focal point or null when no preference is set. */
  modelValue: { x: number; y: number } | null
  /** Image URL to render in the editor. */
  imageUrl: string
  /** Image alt text for the editor preview. Decorative if null/''. */
  alt: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: { x: number; y: number } | null): void
}>()

/**
 * Effective focal point — defaults to center when modelValue is null.
 * Used for marker positioning + preview rendering. Distinct from the
 * underlying state (which is null) so the UI shows the default
 * accurately while persistence stays explicit.
 */
const effective = computed(() => props.modelValue ?? { x: 0.5, y: 0.5 })

const imageRef = ref<HTMLImageElement | null>(null)
const dragging = ref(false)
/** Hover position for the pre-commit translucent marker (null when not hovering). */
const hover = ref<{ x: number; y: number } | null>(null)

/** 0–1 normalized point from a pointer event relative to the image. */
function pointFromEvent(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  const img = imageRef.value
  if (!img) return null
  const rect = img.getBoundingClientRect()
  const clientX = 'touches' in event ? event.touches[0]?.clientX : (event as MouseEvent).clientX
  const clientY = 'touches' in event ? event.touches[0]?.clientY : (event as MouseEvent).clientY
  if (clientX === undefined || clientY === undefined) return null
  // Clamp to [0, 1] so a drag past the edges sticks to the boundary
  // rather than producing out-of-range values that the PATCH would
  // reject with 400.
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
  return { x, y }
}

function onClick(event: MouseEvent): void {
  const pt = pointFromEvent(event)
  if (!pt) return
  emit('update:modelValue', pt)
}

function onPointerDown(event: PointerEvent): void {
  const pt = pointFromEvent(event)
  if (!pt) return
  dragging.value = true
  emit('update:modelValue', pt)
  // Capture pointer events while dragging so the marker tracks even
  // if the cursor leaves the image rect briefly.
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (dragging.value) {
    const pt = pointFromEvent(event)
    if (pt) emit('update:modelValue', pt)
    return
  }
  // Hover preview: track the cursor without committing.
  hover.value = pointFromEvent(event)
}

function onPointerUp(event: PointerEvent): void {
  if (dragging.value) {
    dragging.value = false
    ;(event.target as HTMLElement).releasePointerCapture?.(event.pointerId)
  }
}

function onPointerLeave(): void {
  hover.value = null
}

function onReset(): void {
  emit('update:modelValue', null)
}

const markerStyle = computed(() => ({
  left: `${effective.value.x * 100}%`,
  top: `${effective.value.y * 100}%`,
}))

const hoverStyle = computed(() =>
  hover.value
    ? {
        left: `${hover.value.x * 100}%`,
        top: `${hover.value.y * 100}%`,
      }
    : null,
)

const xPercent = computed(() => Math.round(effective.value.x * 100))
const yPercent = computed(() => Math.round(effective.value.y * 100))

/**
 * Aspect-ratio previews. CSS `object-position` does the heavy lifting
 * — set it from the focal point's percentage and the browser shifts
 * the image accordingly inside a fixed-aspect container. No canvas,
 * no transforms, no math.
 */
const previews = [
  { label: '1:1', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '9:16', ratio: 9 / 16 },
]
const previewObjectPosition = computed(() => `${effective.value.x * 100}% ${effective.value.y * 100}%`)

const isExplicit = computed(() => props.modelValue !== null)
</script>

<template>
  <div class="focal-editor" data-testid="focal-editor">
    <div
      class="focal-stage"
      :class="{ dragging }"
      data-testid="focal-stage"
      @click="onClick"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerLeave">
      <img ref="imageRef" :src="imageUrl" :alt="alt ?? ''" draggable="false" />
      <span
        v-if="hoverStyle && !dragging"
        class="focal-hover-marker"
        :style="hoverStyle"
        data-testid="focal-hover-marker" />
      <span class="focal-marker" :style="markerStyle" data-testid="focal-marker" />
    </div>

    <div class="focal-meta">
      <span class="focal-xy" data-testid="focal-xy">{{ xPercent }}% × {{ yPercent }}%</span>
      <span v-if="!isExplicit" class="focal-default-hint" data-testid="focal-default-hint">
        — using default (center)
      </span>
      <Button
        label="Reset"
        text
        size="small"
        :disabled="!isExplicit"
        data-testid="focal-reset"
        @click="onReset" />
    </div>

    <div class="focal-previews" data-testid="focal-previews">
      <div
        v-for="p in previews"
        :key="p.label"
        class="focal-preview"
        :data-testid="`focal-preview-${p.label}`">
        <div
          class="focal-preview-frame"
          :style="{ aspectRatio: p.ratio }">
          <img :src="imageUrl" :alt="alt ?? ''" :style="{ objectPosition: previewObjectPosition }" />
        </div>
        <span class="focal-preview-label">{{ p.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.focal-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.focal-stage {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  cursor: crosshair;
  background: var(--p-content-hover-background);
  user-select: none;
  touch-action: none;
}

.focal-stage.dragging {
  cursor: grabbing;
}

.focal-stage img {
  display: block;
  width: 100%;
  height: auto;
  pointer-events: none;
}

.focal-marker,
.focal-hover-marker {
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.5);
}

.focal-marker {
  background: var(--p-primary-color);
  border: 2px solid #fff;
}

.focal-hover-marker {
  background: var(--p-primary-color);
  border: 2px solid #fff;
  opacity: 0.5;
}

.focal-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.focal-xy {
  font-variant-numeric: tabular-nums;
  color: var(--p-text-color);
}

.focal-default-hint {
  color: var(--p-text-muted-color);
  font-style: italic;
}

.focal-previews {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
}

.focal-preview {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  align-items: center;
}

.focal-preview-frame {
  width: 100%;
  border-radius: 4px;
  overflow: hidden;
  background: var(--p-content-hover-background);
}

.focal-preview-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.focal-preview-label {
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>
