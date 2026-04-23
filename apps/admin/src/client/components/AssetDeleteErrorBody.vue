<script setup lang="ts">
/**
 * Generic-error body for the delete-confirm dialog.
 *
 * Pure presentation. Receives the error message, renders it. Nothing
 * more. If the error UI grows (details panel, retry button), it grows
 * here without touching the shell or other bodies.
 */
defineProps<{ message: string | null }>()
</script>

<template>
  <p>{{ message }}</p>
</template>
