# Reference (out-pointing) vs. Usage (in-pointing)

The codebase used "ref" and "Reference" for at least four different things: in-content asset/fragment links, location-records of where references occur, fragment-name strings, and storage sidecars. We split: **Reference** is out-pointing (in-content link from one entity to another); **Usage** is in-pointing (a record stating "entity X is referenced from location Y"). The Usage Panel UI surface and the existing `.gazetta/asset-refs/` sidecar storage map to Usage; in-content `{ _asset: "name" }` objects and `"@fragment"` strings are References.

## Note on the code-side type name

The TypeScript type `AssetRef` in `packages/gazetta/src/assets/refs.ts` carries Usage data (location-record), not Reference data. The name predates this clarification; we kept it for stability. A future rename to `AssetUsage` is reasonable but not in scope. In the meantime: `AssetRef` in code = Usage in domain language. The glossary captures this in the "Ref / AssetRef (internal — type name only)" entry.

## Consequences

- "Asset's references" is wrong (asset doesn't reference; it has Usages).
- "Page's references" is right (a Page references zero or more Assets / Fragments).
- A Fragment can have both: References to other Assets, and Usages from Pages that reference it.
- Future ref-tracking features should pick one direction explicitly and use the matching word.
