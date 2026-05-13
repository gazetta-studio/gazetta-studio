/**
 * Cloudflare Workers deploy adapter (Cut 3 of #203).
 *
 * Refactors the hardcoded `gazetta deploy` flow at
 * `cli/index.ts:1230-1314` into a Pattern 1 Provider factory.
 *
 * Operator usage:
 * ```ts
 * import { defineSite, r2Storage, cloudflareWorkersDeploy } from 'gazetta'
 *
 * defineSite({
 *   targets: {
 *     production: {
 *       type: 'dynamic',
 *       storage: r2Storage({...}),
 *       deploy: cloudflareWorkersDeploy({
 *         apiToken: process.env.CLOUDFLARE_API_TOKEN!,
 *         accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
 *         name: 'my-site',
 *         bucket: 'my-site',
 *       }),
 *     },
 *   },
 * })
 * ```
 *
 * # WorkerCapableDeployAdapter
 *
 * Implements the capability extension: `workerRuntimeConfig()`
 * returns the R2 binding metadata `gazetta build` needs.
 *
 * # supports
 *
 * `['esi']` in v1. Per design-deploy.md Q5: `dynamic` deferred to v2
 * when CF Workers + origin pair is supported. Today, the worker
 * reads R2 directly at request time (the `cloudflare-r2` adapter
 * inside `packages/gazetta/src/workers/`) — that's the ESI shape.
 *
 * # SOLID
 *
 *   - SRP: adapter owns Cloudflare Workers deploy mechanics only;
 *     pure helpers (renderWranglerToml, renderWorkerEntry) are
 *     unit-testable independently.
 *   - DIP: CLI depends on `WorkerCapableDeployAdapter` interface,
 *     not on this factory directly. Future CF Pages + Functions
 *     adapter substitutes through the same contract.
 */
import { execSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  DeployContext,
  DeployResult,
  ValidateContext,
  WorkerCapableDeployAdapter,
  WorkerRuntimeConfig,
} from './types.js'
import { DeployAuthError, DeployConfigError, DeployTransportError } from './errors.js'
import type { Issue } from '../validation/types.js'

const ADAPTER_NAME = 'cloudflare-workers'
const BUCKET_BINDING = 'SITE_BUCKET'
const COMPAT_DATE = '2024-12-01'

export interface CloudflareWorkersDeployOptions {
  /** Cloudflare API token with Workers Scripts:Edit + R2 Read:Bucket permissions. */
  apiToken: string
  /** Cloudflare account ID. */
  accountId: string
  /** Worker name (also used as the workers.dev subdomain). */
  name: string
  /** R2 bucket name the worker reads from at request time. */
  bucket: string
}

interface WranglerTomlInput {
  name: string
  bucket: string
  siteUrl: string | undefined
}

/**
 * Render the wrangler.toml content. Pure function; unit-testable
 * without mocking fs.
 */
export function renderWranglerToml(input: WranglerTomlInput): string {
  const { name, bucket, siteUrl } = input
  let out =
    `name = "${name}"\n` +
    `main = "index.ts"\n` +
    `compatibility_date = "${COMPAT_DATE}"\n` +
    `workers_dev = true\n` +
    `\n` +
    `[[r2_buckets]]\n` +
    `binding = "${BUCKET_BINDING}"\n` +
    `bucket_name = "${bucket}"\n`

  if (siteUrl) {
    const url = new URL(siteUrl)
    const hostname = url.hostname
    out += `\n[[routes]]\npattern = "${hostname}/*"\nzone_name = "${hostname}"\n`
  }

  return out
}

/**
 * Render the worker entry-point code. Pure function. The
 * `cloudflare-r2` adapter at `packages/gazetta/src/workers/` provides
 * the actual request-handling logic; the entry is a thin re-export.
 */
export function renderWorkerEntry(): string {
  return `import { createWorker } from 'gazetta/workers/cloudflare-r2'\nexport default createWorker()\n`
}

export function cloudflareWorkersDeploy(opts: CloudflareWorkersDeployOptions): WorkerCapableDeployAdapter {
  // Construction-time validation per Q7 lock: factories validate
  // operator-supplied input synchronously. Bad credentials surface
  // at execute() as DeployAuthError, not here.
  if (!opts.apiToken) {
    throw new DeployConfigError(
      'cloudflareWorkersDeploy requires `apiToken` (e.g., process.env.CLOUDFLARE_API_TOKEN)',
      ADAPTER_NAME,
    )
  }
  if (!opts.accountId) {
    throw new DeployConfigError(
      'cloudflareWorkersDeploy requires `accountId` (e.g., process.env.CLOUDFLARE_ACCOUNT_ID)',
      ADAPTER_NAME,
    )
  }
  if (!opts.name) {
    throw new DeployConfigError(
      'cloudflareWorkersDeploy requires `name` — the worker name + workers.dev subdomain',
      ADAPTER_NAME,
    )
  }
  if (!opts.bucket) {
    throw new DeployConfigError(
      'cloudflareWorkersDeploy requires `bucket` — the R2 bucket the worker reads from',
      ADAPTER_NAME,
    )
  }

  const { apiToken, accountId, name: workerName, bucket } = opts

  return {
    name: ADAPTER_NAME,
    supports: ['esi'] as const,

    workerRuntimeConfig(): WorkerRuntimeConfig {
      return {
        bucketBinding: BUCKET_BINDING,
        // Routes computed lazily from target.siteUrl at deploy time —
        // not at config-eval. `gazetta build` reads the binding name
        // here; the actual route pattern lands in wrangler.toml at
        // deploy time via renderWranglerToml().
      }
    },

    validate(_ctx: ValidateContext): Issue[] {
      // No cross-field invariants in v1 beyond the construction-time
      // checks above. Reserved for future operator-input validation
      // (e.g., warn when target.siteUrl protocol is `http:`).
      return []
    },

    async execute(ctx: DeployContext): Promise<DeployResult> {
      const { target, logger, signal } = ctx

      const tmpDir = join(process.cwd(), '.gazetta-deploy')
      await rm(tmpDir, { recursive: true, force: true })
      await mkdir(tmpDir, { recursive: true })

      try {
        const tomlBody = renderWranglerToml({
          name: workerName,
          bucket,
          siteUrl: target.siteUrl,
        })
        await writeFile(join(tmpDir, 'wrangler.toml'), tomlBody)
        await writeFile(join(tmpDir, 'index.ts'), renderWorkerEntry())
        await writeFile(
          join(tmpDir, 'package.json'),
          JSON.stringify({ type: 'module', dependencies: { gazetta: '*', hono: '*' } }),
        )

        if (signal.aborted) throw new DeployTransportError('Deploy aborted by signal', ADAPTER_NAME)

        logger.info({ workerName, bucket }, 'Deploying worker to Cloudflare')

        // Resolve the gazetta package install root for --install-links.
        // import.meta.dirname is two levels above (src/deploy/).
        const gazettaRoot = resolve(import.meta.dirname, '../..')
        execSync(`npm install --install-links ${gazettaRoot}`, { cwd: tmpDir, stdio: 'pipe' })

        if (signal.aborted) throw new DeployTransportError('Deploy aborted by signal', ADAPTER_NAME)

        // Wrangler reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
        // from env per its own convention; pass through.
        const wranglerOut = execSync('npx wrangler deploy', {
          cwd: tmpDir,
          stdio: 'pipe',
          env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: accountId },
        }).toString()

        const urlMatch = wranglerOut.match(/https:\/\/[^\s]+/)
        const url = urlMatch?.[0]

        logger.info({ workerName, url }, 'Worker deployed')

        return {
          url,
          details: { wranglerOutput: wranglerOut },
        }
      } catch (err) {
        if (err instanceof DeployTransportError) throw err
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? (err as Error).message
        // Heuristic: wrangler exits with auth-related messages when
        // the token is bad. Distinguish auth vs transport here.
        if (/authentication|unauthorized|invalid token/i.test(stderr)) {
          throw new DeployAuthError(`Cloudflare rejected credentials: ${stderr}`, ADAPTER_NAME)
        }
        throw new DeployTransportError(`Wrangler deploy failed: ${stderr}`, ADAPTER_NAME)
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    },
  }
}
