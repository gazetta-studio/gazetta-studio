# Content Authoring with Assets

How to use the asset library as a content author. Upload, organize,
override per locale, set focal points, fix alt text — what each
affordance does and when to use it.

For the design model, see [`.claude/rules/design-media.md`](../.claude/rules/design-media.md).

## Opening the library

Three entry points, all stay synced with the active target:

| Where | When |
|---|---|
| **`Cmd+L` / `Ctrl+L`** | Anywhere in the admin |
| **Asset picker** in a page editor | A schema field declares `embeddedAsset()` / `downloadable()` / `fontAsset()` |
| **Active-target menu → Asset library** | Manual entry from the top bar |

The library shows assets on the **active target** — switch targets in
the top bar and the library refreshes.

## Uploading

Drag-and-drop into the upload zone or click to pick files. Image
uploads (JPEG, PNG, SVG) get responsive variants generated in the
background; SVGs are sanitized before storage (script tags, event
handlers, external `href`s, oversized embedded base64 are all stripped
or rejected).

Each upload becomes one **history revision** — `Cmd+Z`-equivalent
undo via the history panel. Bulk drops produce one revision per file
so you can selectively roll back.

### Alt text at upload (optional)

When an image upload finishes, the row in the upload list shows an
inline alt-text input:

```
hero.jpg                              Done
[ Describe the image ........ ] ☐ Decorative
```

Three behaviors:
- **Type alt + tab away** → meaningful alt saved
- **Check "Decorative"** → alt set to `""` (screen readers skip it)
- **Skip / close library** → alt stays `null`; the library card shows
  an amber "ALT" badge so you can fix it later

Alt is non-blocking at upload — fill it now, fill it later via the
detail pane, or override per-use on each page that references the asset.

### Locale-bytes upload (when active locale ≠ default)

If the **active locale** is not the site's default locale, and you
drag a file whose name matches an existing asset, the admin asks:

| Choice | What happens |
|---|---|
| **Replace default bytes** | The new bytes become the canonical asset. Every locale that doesn't have its own override now uses these. |
| **Add {locale} bytes override** *(recommended)* | The default stays. The new bytes are used only when this locale is active. |
| **Cancel** | Abort. |

The "Add override" branch creates a new manifest variant
(`hero.asset.fr.json`) and stores the bytes under
`hero-{hash}.fr.jpg`. When a different locale is active, the resolver
falls back through `(active locale, active theme) → (active locale,
default theme) → (default locale, …)` so French pages get the French
bytes and English pages get the default.

## The detail pane

Click a card. The right pane shows:

```
[thumbnail]
hero
─────────────────
Kind         embedded
Type         image/jpeg
Size         245 KB
Dimensions   1920 × 1080
Alt          [ Mountain sunset ] ☐ Decorative
Focal point  [ ⊕ ]                  50% × 30%   Reset
             ▢ ▢ ▢ ▢                            (1:1, 16:9, 4:5, 9:16 previews)
─────────────────
LOCALE BYTES
[Default]    en    245 KB · 1920×1080
[fr]         override                       Remove override
+ Add ar version
─────────────────
Uploaded     2026-04-22 14:23
[ Delete ]
```

### Editing alt

Inline three-state input + "Decorative" checkbox. Commits on blur.

### Setting a focal point

Click anywhere on the focal-point preview. The marker locks in;
drag to fine-tune. The four aspect-ratio thumbnails (1:1, 16:9,
4:5, 9:16) update live so you can see what the crop will look like
in different contexts.

`Reset` returns to the default (no preference set; templates render
at center). The x/y badge shows the current focal as a percentage.

### Locale bytes section

Always visible when the site has more than one locale. Shows:
- **Default** row (always present, shows the canonical bytes)
- One row per existing locale-bytes override
- `+ Add {locale} version` button for every site-supported locale
  that doesn't have an override

Click `+ Add fr version` → file picker → upload. The new bytes are
used for French content; English content keeps using the default.

`Remove override` deletes one locale-bytes variant; that locale falls
back to the default bytes after removal.

### Library card coverage badge

Each card in the grid shows a chip strip:

```
en (default — primary color)
fr (override — blue)
ar (fallback — dashed border)
```

At a glance: which locales have their own bytes, which fall back to
default, and where the missing-alt nag (separate amber "ALT" pill on
the thumbnail) needs attention.

## Replace, rename, delete

### Replace

When you want to swap one asset for another *without* breaking any
references — author picks a replacement asset from the library, the
admin rewrites every reference (across pages, fragments, every
locale variant) to point at the new asset, then deletes the old one.
One history revision covers the whole operation.

Compatibility: replace requires the same kind + same MIME category.
Image → image (JPEG → PNG is fine), but image → PDF is rejected.

### Rename

Like replace but the asset's identity stays the same — bytes and
manifest move from `hero` to `banner`, every reference rewritten,
old paths cleaned up. One history revision.

**v1 limitation:** rename refuses on assets that have locale-bytes
overrides. Remove the overrides first, then rename. (Override-aware
rename is tracked for v1.5.)

### Delete

| State | Behavior |
|---|---|
| 0 references | Confirm + delete |
| 1+ references | Blocked. Detail pane shows the "in use" panel — click a referenced page to fix it, OR pick a replacement |

When an asset has locale-bytes overrides, deleting the asset cascades
through all overrides — bytes, variants, locale manifests all removed
in one history revision.

## Picking assets in the page editor

When a template field declares an asset reference (`embeddedAsset`,
`downloadable`, `fontAsset`), the page editor renders an asset-picker
button. Clicking opens the library modal with the field's `accept`
filter applied — only compatible assets are shown.

Confirm picks the asset. The reference-options step (when the field
allows alt or focal-point overrides) shows the chain explicitly:

```
Alt text
[ Page-specific alt for this hero ]
   Falls back to: "Mountain sunset" (asset's alt)

Focal point
[focal picker, defaults to asset's focal]
```

Per-reference values live on the page manifest — they don't change
the asset itself. Useful when the same hero image needs different
alt text on the homepage vs. the about page, or different framing
in different layouts.

## Per-asset history

Every asset operation (upload, replace, rename, delete, alt edit,
focal edit, locale-bytes override) records a history revision on
the active target. Open the history panel from the top-bar target
menu to undo individual changes or restore an earlier revision.

History is per-target — undo on a non-default target (e.g. staging)
doesn't affect production.

## Locale and theme model recap

Two override dimensions:

| Dimension | Drives | Examples |
|---|---|---|
| **Locale** | Language-specific bytes | French version of a hero with text baked in |
| **Theme** | Presentation-specific bytes | Dark-mode logo |

Either can be overridden, both, or neither. The resolver picks at
render time using the **locale-priority fallback chain**: when
serving `(fr, dark)` and a French dark variant doesn't exist, try
French light; only fall through to default-locale variants when no
French variant exists at all.

In v1 the asset library exposes locale overrides; theme overrides
are a v1.5 UX surface (the data model already supports them).

## See also

- [`.claude/rules/design-media.md`](../.claude/rules/design-media.md) — full design model
- [`.claude/rules/design-editor-ux.md`](../.claude/rules/design-editor-ux.md) — active-target UX, switching, undo
- [template-assets.md](template-assets.md) — for template developers
