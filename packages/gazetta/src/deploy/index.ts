/**
 * Deploy barrel. Cut 1 ships the type-only foundation; subsequent
 * cuts add the validators (Cut 2), `cloudflareWorkersDeploy()`
 * factory + CLI refactor (Cut 3), and docs (Cut 4).
 */
export type {
  DeployAdapter,
  DeployContext,
  DeployLogger,
  DeployResult,
  ValidateContext,
  WorkerCapableDeployAdapter,
  WorkerRuntimeConfig,
} from './types.js'
export {
  DeployAuthError,
  DeployConfigError,
  DeployContentError,
  DeployError,
  DeployTransportError,
} from './errors.js'
export {
  cloudflareWorkersDeploy,
  extractDeployUrl,
  renderWorkerEntry,
  renderWranglerToml,
  type CloudflareWorkersDeployOptions,
} from './cloudflare-workers.js'
