<script setup lang="ts">
/**
 * Route view for `/cli-signin`: loads how a command line signs in here and,
 * behind ALB, creates the grant to paste (design-agent-access.md Q15, Q23).
 * The server answers only a browser sign-in (Q19).
 */
import { onMounted, ref } from 'vue'
import { ApiError } from '../api/client.js'
import { createCliGrant, getCliSetup } from '../api/cliSignin.js'
import CliSigninCard from './CliSigninCard.vue'
import type { CliSigninState } from './cliSigninState.js'

const state = ref<CliSigninState>({ kind: 'loading' })
const busy = ref(false)

/** The URL `gz auth login` takes: the site's, since gz adds `/admin` itself. */
function adminUrl(): string {
  return window.location.origin
}

function failure(err: unknown): CliSigninState {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return { kind: 'signed-out' }
  return { kind: 'error', detail: err instanceof Error ? err.message : String(err) }
}

onMounted(async () => {
  try {
    state.value = { kind: 'ready', setup: await getCliSetup(), adminUrl: adminUrl() }
  } catch (err) {
    state.value = failure(err)
  }
})

async function create(machine: string) {
  const current = state.value
  if (current.kind !== 'ready') return
  busy.value = true
  try {
    const { grantSecret } = await createCliGrant(machine)
    state.value = { ...current, created: { grantSecret, machine } }
  } catch (err) {
    state.value = failure(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <CliSigninCard :state="state" :busy="busy" @create="create" />
</template>
