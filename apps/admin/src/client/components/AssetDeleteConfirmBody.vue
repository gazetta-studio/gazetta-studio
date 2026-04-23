<script setup lang="ts">
/**
 * "Are you sure?" body for the delete-confirm dialog.
 *
 * Pure presentation — receives the asset name, renders the prompt. No
 * store access, no side effects. The shell owns all state and wiring;
 * this component changes only when the confirmation copy changes.
 */
defineProps<{ assetName: string }>()
</script>

<template>
  <p>
    Delete <strong data-testid="asset-delete-name">{{ assetName }}</strong
    >? This cannot be undone.
  </p>
</template>
