<script setup lang="ts">
/**
 * The CLI sign-in card: the login's details and Approve / Deny while it is
 * pending, otherwise one message. Presentational; CliLoginView loads and
 * decides.
 */
import { TriangleAlert } from '@lucide/vue'
import { computed } from 'vue'
import Button from './ui/Button.vue'
import type { CliLoginState } from './cliLoginState.js'

const props = defineProps<{ state: CliLoginState; busy?: boolean }>()
defineEmits<{ approve: []; deny: [] }>()

const started = computed(() =>
  props.state.kind === 'pending' ? new Date(props.state.login.startedAt).toLocaleString() : '',
)
</script>

<template>
  <main class="cli-login" data-testid="cli-login">
    <div class="cli-login-card">
      <p v-if="state.kind === 'loading'" class="cli-login-message" data-testid="cli-login-loading">Loading…</p>

      <template v-else-if="state.kind === 'pending'">
        <h1 class="cli-login-heading">Approve a sign-in from the command line</h1>
        <dl class="cli-login-details">
          <div class="cli-login-row">
            <dt>Code</dt>
            <dd class="cli-login-code" data-testid="cli-login-code">{{ state.login.code }}</dd>
          </div>
          <div class="cli-login-row">
            <dt>Machine</dt>
            <dd data-testid="cli-login-machine">{{ state.login.machine }}</dd>
          </div>
          <div v-if="state.login.ip" class="cli-login-row">
            <dt>IP address</dt>
            <dd data-testid="cli-login-ip">{{ state.login.ip }}</dd>
          </div>
          <div class="cli-login-row">
            <dt>Started</dt>
            <dd data-testid="cli-login-started">{{ started }}</dd>
          </div>
        </dl>
        <p class="cli-login-warning" data-testid="cli-login-warning">
          <TriangleAlert class="cli-login-warning-icon" aria-hidden="true" />
          <span>Only approve a code you started yourself. Approving lets that machine edit content as you.</span>
        </p>
        <div class="cli-login-actions">
          <Button label="Deny" severity="secondary" outlined :disabled="busy" data-testid="cli-login-deny"
            @click="$emit('deny')" />
          <Button label="Approve" :disabled="busy" data-testid="cli-login-approve" @click="$emit('approve')" />
        </div>
      </template>

      <p v-else-if="state.kind === 'approved'" class="cli-login-message" role="status" data-testid="cli-login-approved">
        Approved. You can go back to your terminal.
      </p>
      <p v-else-if="state.kind === 'denied'" class="cli-login-message" role="status" data-testid="cli-login-denied">
        Denied. The command line won't be signed in.
      </p>
      <p v-else-if="state.kind === 'expired'" class="cli-login-message" role="status" data-testid="cli-login-expired">
        This code has expired. Start the sign-in again from your terminal.
      </p>
      <p v-else-if="state.kind === 'not-found'" class="cli-login-message" role="status"
        data-testid="cli-login-not-found">
        No sign-in with this code. Check the code in your terminal.
      </p>
      <p v-else class="cli-login-message cli-login-error" role="alert" data-testid="cli-login-error">
        Couldn't load this sign-in: {{ state.detail }}
      </p>
    </div>
  </main>
</template>

<style scoped>
.cli-login {
  min-block-size: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: var(--color-bg);
  color: var(--color-fg);
}
.cli-login-card {
  inline-size: 100%;
  max-inline-size: 28rem;
  padding: 1.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  box-shadow: var(--shadow-overlay);
  font-size: 0.875rem;
  line-height: 1.5;
}
.cli-login-heading {
  font-size: 1.125rem;
  font-weight: 600;
  margin-block-end: 1rem;
}
.cli-login-details {
  display: grid;
  gap: 0.5rem;
  margin-block-end: 1rem;
}
.cli-login-row {
  display: grid;
  grid-template-columns: 7rem 1fr;
  gap: 0.75rem;
}
.cli-login-row dt {
  color: var(--color-muted);
}
.cli-login-row dd {
  overflow-wrap: anywhere;
}
.cli-login-code {
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.05em;
}
.cli-login-warning {
  display: flex;
  gap: 0.5rem;
  align-items: flex-start;
  padding: 0.75rem;
  margin-block-end: 1rem;
  border-radius: var(--radius-sm);
  background: var(--color-warning-bg);
  color: var(--color-warning-fg);
}
.cli-login-warning-icon {
  inline-size: 1rem;
  block-size: 1rem;
  flex-shrink: 0;
  margin-block-start: 0.125rem;
}
.cli-login-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.cli-login-error {
  color: var(--color-danger-fg);
}
</style>
