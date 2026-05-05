import { defineSite } from 'gazetta'

export default defineSite({
  name: 'Target Matrix Fixture',
  version: '1.0.0',
  targets: {
    // Axis coverage (environment × editable × type). Each target exists
    // to prove the admin UI reacts correctly to one combination. Minimal
    // storage — filesystem — because matrix tests don't exercise publish
    // execution, only the UI that reacts to target properties.

    // --- local environment ---
    'local-edit': {
      storage: { type: 'filesystem' },
      // path defaults to ./targets/local-edit — where the source content
      // lives. environment: local, editable: true, type: static (all defaults).
    },

    'local-ro': {
      storage: { type: 'filesystem', path: './dist/local-ro' },
      editable: false,
      // Local target that's NOT editable — an override of the default.
      // Proves the editable flag is respected even against env defaults.
    },

    'local-dyn': {
      storage: { type: 'filesystem', path: './dist/local-dyn' },
      type: 'dynamic',
      // Editable dynamic local — proves the type flag flows independently
      // of environment.
    },

    // --- staging environment ---
    'staging-ro': {
      storage: { type: 'filesystem', path: './dist/staging-ro' },
      environment: 'staging',
      // editable: false is the env default for staging
    },

    'staging-edit': {
      storage: { type: 'filesystem', path: './dist/staging-edit' },
      environment: 'staging',
      editable: true,
      // Editable staging — overrides the env default for draft-editing
      // workflows on staging.
    },

    // --- production environment ---
    'prod-ro': {
      storage: { type: 'filesystem', path: './dist/prod-ro' },
      environment: 'production',
    },

    'prod-edit': {
      storage: { type: 'filesystem', path: './dist/prod-edit' },
      environment: 'production',
      editable: true,
      // Hotfix-accepting production — unblocks the deferred Phase 3 scenario
      // (source=prod → local). Without editable:true the source dropdown
      // doesn't show prod.
    },

    'prod-dyn': {
      storage: { type: 'filesystem', path: './dist/prod-dyn' },
      environment: 'production',
      type: 'dynamic',
    },
  },
})
