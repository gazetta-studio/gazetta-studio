<script setup lang="ts">
/**
 * Route view for `/cli-login/:code`: loads the CLI sign-in and sends the
 * person's decision. The server accepts it only from a browser sign-in
 * (design-agent-access.md Q19).
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError } from '../api/client.js'
import { decideCliLogin, getCliLogin } from '../api/cliLogin.js'
import CliLoginCard from './CliLoginCard.vue'
import type { CliLoginState } from './cliLoginState.js'

const route = useRoute()
const code = String(route.params.code ?? '')
const state = ref<CliLoginState>({ kind: 'loading' })
const busy = ref(false)

function failure(err: unknown): CliLoginState {
  if (err instanceof ApiError) {
    if (err.status === 404) return { kind: 'not-found' }
    if (err.status === 410) return { kind: 'expired' }
    return { kind: 'error', detail: err.message }
  }
  return { kind: 'error', detail: err instanceof Error ? err.message : String(err) }
}

onMounted(async () => {
  try {
    const login = await getCliLogin(code)
    if (login.state !== 'pending') state.value = { kind: login.state }
    else if (Date.parse(login.expiresAt) <= Date.now()) state.value = { kind: 'expired' }
    else state.value = { kind: 'pending', login }
  } catch (err) {
    state.value = failure(err)
  }
})

async function decide(decision: 'approve' | 'deny') {
  busy.value = true
  try {
    const result = await decideCliLogin(code, decision)
    state.value = { kind: result.state }
  } catch (err) {
    // 409: already decided elsewhere; read it back to show which way.
    if (err instanceof ApiError && err.status === 409) {
      try {
        const login = await getCliLogin(code)
        state.value = login.state === 'pending' ? failure(err) : { kind: login.state }
      } catch (reloadErr) {
        state.value = failure(reloadErr)
      }
    } else {
      state.value = failure(err)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <CliLoginCard :state="state" :busy="busy" @approve="decide('approve')" @deny="decide('deny')" />
</template>
