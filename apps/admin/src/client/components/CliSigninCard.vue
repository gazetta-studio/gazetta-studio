<script setup lang="ts">
/**
 * "Sign in a command line" (design-agent-access.md Q15, Q23): the gz
 * command to run, a shared Cloudflare service token to copy when the
 * operator configured one, and, behind ALB, a grant created here to paste
 * into gz. Presentational; CliSigninView loads and creates.
 */
import { Check, Copy } from '@lucide/vue'
import { computed, ref } from 'vue'
import Button from './ui/Button.vue'
import TextInput from './ui/TextInput.vue'
import type { CliSigninState } from './cliSigninState.js'

const props = defineProps<{ state: CliSigninState; busy?: boolean }>()
const emit = defineEmits<{ create: [machine: string] }>()

const machine = ref('')
const copied = ref<string>()

const loginCommand = computed(() => {
  const s = props.state
  if (s.kind !== 'ready') return ''
  return `gz auth login ${s.adminUrl}${s.setup.paste ? ' --paste' : ''}`
})

async function copy(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
  } catch {
    copied.value = undefined
  }
}

function create() {
  const name = machine.value.trim()
  if (name) emit('create', name)
}
</script>

<template>
  <main class="cli-signin" data-testid="cli-signin">
    <div class="cli-signin-card">
      <p v-if="state.kind === 'loading'" class="cli-signin-message" role="status" data-testid="cli-signin-loading">
        Loading…
      </p>
      <p v-else-if="state.kind === 'signed-out'" class="cli-signin-message" role="status"
        data-testid="cli-signin-signed-out">
        Sign in to the admin in this browser first.
      </p>
      <p v-else-if="state.kind === 'error'" class="cli-signin-message cli-signin-error" role="alert"
        data-testid="cli-signin-error">
        Couldn't load this page: {{ state.detail }}
      </p>
      <template v-else>
        <h1 class="cli-signin-heading">Sign in a command line</h1>

        <section v-if="state.setup.cloudflare" class="cli-signin-section" data-testid="cli-signin-cloudflare">
          <p>This admin is behind Cloudflare Access. Give gz this service token when it asks, or set it in the
            environment as <code>GZ_CF_ACCESS_CLIENT_ID</code> and <code>GZ_CF_ACCESS_CLIENT_SECRET</code>.</p>
          <dl class="cli-signin-fields">
            <div v-for="field in [
              { key: 'id', label: 'Client ID', value: state.setup.cloudflare.clientId },
              { key: 'secret', label: 'Client secret', value: state.setup.cloudflare.clientSecret },
            ]" :key="field.key" class="cli-signin-field">
              <dt>{{ field.label }}</dt>
              <dd>
                <code class="cli-signin-value">{{ field.value }}</code>
                <Button size="small" text :aria-label="`Copy ${field.label}`"
                  :data-testid="`cli-signin-copy-cf-${field.key}`" @click="copy(`cf-${field.key}`, field.value)" :icon="copied === `cf-${field.key}` ? Check : Copy" />
              </dd>
            </div>
          </dl>
        </section>

        <section v-if="state.setup.paste && !state.created" class="cli-signin-section" data-testid="cli-signin-paste">
          <p>This admin is behind a load balancer, so gz can't show you a code to approve. Create a sign-in here
            and paste it into gz.</p>
          <form class="cli-signin-form" @submit.prevent="create">
            <label class="cli-signin-label" for="cli-signin-machine">Machine name</label>
            <TextInput id="cli-signin-machine" v-model="machine" placeholder="alice-laptop"
              data-testid="cli-signin-machine" />
            <Button :disabled="busy || !machine.trim()" :loading="busy" data-testid="cli-signin-create"
              @click="create">Create sign-in</Button>
          </form>
        </section>

        <section v-if="state.created" class="cli-signin-section" data-testid="cli-signin-created">
          <p>Copy this now: it won't be shown again. Paste it when <code>{{ loginCommand }}</code> asks for it.
            It signs in {{ state.created.machine }} as you, to edit content.</p>
          <div class="cli-signin-secret">
            <code class="cli-signin-value" data-testid="cli-signin-secret">{{ state.created.grantSecret }}</code>
            <Button size="small" text aria-label="Copy the sign-in" data-testid="cli-signin-copy-secret"
              @click="copy('secret', state.created.grantSecret)" :icon="copied === 'secret' ? Check : Copy" />
          </div>
        </section>

        <section class="cli-signin-section">
          <p>{{ state.setup.paste ? 'Then run' : 'Run' }} this in your terminal{{ state.setup.paste ? '' : ' and approve the code it shows' }}:</p>
          <div class="cli-signin-secret">
            <code class="cli-signin-value" data-testid="cli-signin-command">{{ loginCommand }}</code>
            <Button size="small" text aria-label="Copy the command" data-testid="cli-signin-copy-command"
              @click="copy('command', loginCommand)" :icon="copied === 'command' ? Check : Copy" />
          </div>
        </section>
      </template>
    </div>
  </main>
</template>

<style scoped>
.cli-signin {
  min-block-size: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: var(--color-bg);
  color: var(--color-fg);
}
.cli-signin-card {
  inline-size: 100%;
  max-inline-size: 32rem;
  padding: 1.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  box-shadow: var(--shadow-overlay);
  font-size: 0.875rem;
  line-height: 1.5;
}
.cli-signin-heading {
  font-size: 1.125rem;
  font-weight: 600;
  margin-block-end: 1rem;
}
.cli-signin-section {
  display: grid;
  gap: 0.75rem;
  margin-block-end: 1.25rem;
}
.cli-signin-section:last-child {
  margin-block-end: 0;
}
.cli-signin-fields {
  display: grid;
  gap: 0.5rem;
}
.cli-signin-field {
  display: grid;
  grid-template-columns: 7rem 1fr;
  gap: 0.75rem;
  align-items: center;
}
.cli-signin-field dt {
  color: var(--color-muted);
}
.cli-signin-field dd,
.cli-signin-secret {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-inline-size: 0;
}
.cli-signin-value {
  flex: 1;
  min-inline-size: 0;
  overflow-wrap: anywhere;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--color-bg-code);
  font-family: var(--font-mono);
}
.cli-signin-form {
  display: grid;
  gap: 0.5rem;
  justify-items: start;
}
.cli-signin-form :deep(input) {
  inline-size: 100%;
}
.cli-signin-label {
  font-weight: 500;
}
.cli-signin-error {
  color: var(--color-danger-fg);
}
</style>
