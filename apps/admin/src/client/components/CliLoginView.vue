<script setup lang="ts">
/**
 * Route view for `/cli-login/:code`: loads the CLI sign-in or elevation and
 * sends the person's decision. The server accepts it only from a browser
 * sign-in (design-agent-access.md Q19). An approved elevation can be ended
 * here before its 15 minutes run out (Q17).
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError } from '../api/client.js'
import { type CliLogin, type CliLoginDecision, decideCliLogin, endElevation, getCliLogin } from '../api/cliLogin.js'
import CliLoginCard from './CliLoginCard.vue'
import type { CliLoginState } from './cliLoginState.js'

const route = useRoute()
const code = String(route.params.code ?? '')
const state = ref<CliLoginState>({ kind: 'loading' })
const codeKind = ref<'login' | 'elevation'>()
const busy = ref(false)
let loaded: CliLogin | undefined

function failure(err: unknown): CliLoginState {
  if (err instanceof ApiError) {
    if (err.status === 404) return { kind: 'not-found' }
    if (err.status === 410) return { kind: 'expired' }
    return { kind: 'error', detail: err.message }
  }
  return { kind: 'error', detail: err instanceof Error ? err.message : String(err) }
}

/** The state for a decided code; `decision` overrides what was loaded. */
function decided(login: CliLogin, decision: CliLoginDecision): CliLoginState {
  if (login.kind !== 'elevation') return { kind: decision.state }
  if (decision.state === 'denied') return { kind: 'denied', elevation: true }
  const { elevationId, endsAt } = decision
  if (elevationId && endsAt && Date.parse(endsAt) > Date.now()) {
    return { kind: 'elevation-active', machine: login.machine, elevationId, endsAt }
  }
  return { kind: 'elevation-ended', machine: login.machine }
}

function show(login: CliLogin) {
  loaded = login
  codeKind.value = login.kind ?? 'login'
  if (login.state !== 'pending') state.value = decided(login, { ...login, state: login.state })
  else if (Date.parse(login.expiresAt) <= Date.now()) state.value = { kind: 'expired' }
  else state.value = { kind: 'pending', login }
}

onMounted(async () => {
  try {
    show(await getCliLogin(code))
  } catch (err) {
    state.value = failure(err)
  }
})

async function decide(decision: 'approve' | 'deny') {
  busy.value = true
  try {
    const result = await decideCliLogin(code, decision)
    state.value = loaded ? decided(loaded, result) : { kind: result.state }
  } catch (err) {
    // 409: already decided elsewhere, or the sign-in an elevation was for has
    // ended; read it back to show which.
    if (err instanceof ApiError && err.status === 409) {
      try {
        const login = await getCliLogin(code)
        if (login.state === 'pending') state.value = failure(err)
        else show(login)
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

async function end() {
  const current = state.value
  if (current.kind !== 'elevation-active') return
  busy.value = true
  try {
    await endElevation(current.elevationId)
    state.value = { kind: 'elevation-ended', machine: current.machine }
  } catch (err) {
    state.value = failure(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <CliLoginCard :state="state" :code-kind="codeKind" :busy="busy" @approve="decide('approve')"
    @deny="decide('deny')" @end="end" />
</template>
