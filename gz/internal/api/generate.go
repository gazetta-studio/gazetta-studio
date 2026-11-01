// Package api is gz's client for the admin API, generated from the OpenAPI
// document by oapi-codegen (design-agent-access.md Q8). Regenerate with
// `npm run gz:api` from the repository root; a test fails when the
// committed client is stale.
package api

//go:generate go tool oapi-codegen -config oapi-codegen.yaml -o client.gen.go openapi.json
