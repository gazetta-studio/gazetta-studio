// Storybook's preview lives at the repo root, but pinia is the admin's
// dependency: npm may install it under apps/admin/node_modules only (pinia 4
// needs a @vue/devtools-api the root can't share). Importing it from here
// resolves the same copy the admin's stores use.
export { createPinia } from 'pinia'
