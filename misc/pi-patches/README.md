# Pi AI compatibility patches

Patch asset names are deliberately versionless. `pi-ai-patch-manifest.json` is
the single source of truth for the supported Pi version and for the original
and patched hashes. The installer and tests always read it, so a Pi release
does not require renaming scripts, tests, or patch files.

## Upgrade workflow

1. Install the Pi release, update the exact `@earendil-works/pi-ai` key in
   `pnpm-workspace.yaml`, then pin the extension dependencies to the same
   exact version:

   ```sh
   cd home/.pi/agent/extensions
   pnpm add --save-exact \
     @earendil-works/pi-ai@"$(pi --version)" \
     @earendil-works/pi-coding-agent@"$(pi --version)" \
     @earendil-works/pi-tui@"$(pi --version)"
   ```

2. Review each target in `pi-ai-patch-manifest.json` against the newly
   installed `@earendil-works/pi-ai` source. Update the canonical multi-file
   `pi-ai.patch` only when the upstream source requires it. If the old patch
   does not apply, use `pnpm patch @earendil-works/pi-ai@VERSION --ignore-existing`
   to prepare the new package before regenerating the patch.
3. Update the manifest version and the original/patched SHA-256 hashes. If the
   upstream target is unchanged, retain the existing patch and hashes.
4. Update version-specific documentation and assertions outside this directory,
   then validate:

   ```sh
   cd home/.pi/agent/extensions
   pnpm run test:pi-patch
   pnpm run compatibility:check
   ```

`pnpm-workspace.yaml` maps the supported Pi release to
`patches/pi-ai.patch`; that path is a relative symlink to this canonical
asset, so pnpm patches the extension-local `pi-ai` tree automatically. The
global Pi runtime cannot use pnpm's patched dependency, so retain
`apply-pi-ai.mjs`: run `node misc/pi-patches/apply-pi-ai.mjs --check` from the
repository root to verify it, or omit `--check` to apply it. The canonical
patch is deliberately versionless, so a Pi release does not require a patch
filename rename.
