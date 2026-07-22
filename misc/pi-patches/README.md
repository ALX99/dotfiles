# Pi AI compatibility patches

Patch asset names are deliberately versionless. `pi-ai-patch-manifest.json` is
the single source of truth for the supported Pi version and for the original
and patched hashes. The installer and tests always read it, so a Pi release
does not require renaming scripts, tests, or patch files.

## Upgrade workflow

1. Install the Pi release, then pin the extension dependencies to the same
   exact version:

   ```sh
   cd home/.pi/agent/extensions
   npm install --save-exact \
     @earendil-works/pi-ai@"$(pi --version)" \
     @earendil-works/pi-coding-agent@"$(pi --version)" \
     @earendil-works/pi-tui@"$(pi --version)"
   ```

2. Review each target in `pi-ai-patch-manifest.json` against the newly
   installed `@earendil-works/pi-ai` source. Update its patch only when the
   upstream source requires it.
3. Update the manifest version and the original/patched SHA-256 hashes. If the
   upstream target is unchanged, retain the existing patch and hashes.
4. Update version-specific documentation and assertions outside this directory,
   then validate:

   ```sh
   cd home/.pi/agent/extensions
   npm run test:pi-patch
   npm run compatibility:check
   ```

Run `node misc/pi-patches/apply-pi-ai.mjs --check` from the repository root to
confirm that the installed global Pi tree has the patch. Omit `--check` to
apply it.
