import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: 'Target Matrix Fixture',
  version: '1.0.0',
  targets: {
    // Axis coverage (environment × editable × type). Each target exists
    // to prove the admin UI reacts correctly to one combination. Minimal
    // storage — filesystem — because matrix tests don't exercise publish
    // execution, only the UI that reacts to target properties. Relative
    // paths anchor to this config file's directory.

    // --- local environment ---
    'local-edit': {
      storage: filesystemStorage({ path: './targets/local-edit' }),
      // The source content lives here. environment: local, editable: true,
      // type: static (all defaults).
    },

    'local-ro': {
      storage: filesystemStorage({ path: './dist/local-ro' }),
      editable: false,
      // Local target that's NOT editable — an override of the default.
      // Proves the editable flag is respected even against env defaults.
    },

    'local-dyn': {
      storage: filesystemStorage({ path: './dist/local-dyn' }),
      type: 'dynamic',
      // Editable dynamic local — proves the type flag flows independently
      // of environment.
    },

    // --- staging environment ---
    'staging-ro': {
      storage: filesystemStorage({ path: './dist/staging-ro' }),
      environment: 'staging',
      // editable: false is the env default for staging
    },

    'staging-edit': {
      storage: filesystemStorage({ path: './dist/staging-edit' }),
      environment: 'staging',
      editable: true,
      // Editable staging — overrides the env default for draft-editing
      // workflows on staging.
    },

    // --- production environment ---
    'prod-ro': {
      storage: filesystemStorage({ path: './dist/prod-ro' }),
      environment: 'production',
    },

    'prod-edit': {
      storage: filesystemStorage({ path: './dist/prod-edit' }),
      environment: 'production',
      editable: true,
      // Hotfix-accepting production — unblocks the deferred Phase 3 scenario
      // (source=prod → local). Without editable:true the source dropdown
      // doesn't show prod.
    },

    'prod-dyn': {
      storage: filesystemStorage({ path: './dist/prod-dyn' }),
      environment: 'production',
      type: 'dynamic',
    },
  },
})
