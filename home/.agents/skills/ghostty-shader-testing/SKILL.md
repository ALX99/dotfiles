---
name: ghostty-shader-testing
description: Reproduce and verify Ghostty GLSL custom-shader compositing issues with reference screenshots and a Chrome WebGL2 harness.
---

# Ghostty shader testing

Use this skill when a Ghostty custom shader has visual artifacts, terminal text
contrast problems, or uncertain interactions between multiple shaders. Test
the actual compositor behavior instead of relying only on source inspection.

## Establish the pipeline

Inspect the Ghostty config first:

```sh
grep -n 'custom-shader' ~/.config/ghostty/config
readlink ~/.config/ghostty/*.glsl
```

Read the installed Ghostty custom-shader documentation before assuming a
uniform or texture contract:

```text
/Applications/Ghostty.app/Contents/Resources/ghostty/doc/ghostty.1.md
```

Important facts:

- `iChannel0` is the current terminal texture.
- Multiple custom shaders run in configuration order; each shader receives
  the previous shader's output through `iChannel0`.
- `iBackgroundColor`, `iForegroundColor`, cursor uniforms, and palette
  uniforms are available.
- `mainImage(out vec4 fragColor, in vec2 fragCoord)` is the shader entry point.

Do not test a scene shader in isolation when another custom shader precedes
it. A preceding shader's bloom, scanlines, vignette, or cursor effects are
part of the input texture seen by the scene shader.

## Build one reproducible harness

Use the reusable harness generator shipped with this skill:

```sh
python3 home/.agents/skills/ghostty-shader-testing/scripts/build_harness.py \
	--root "$PWD" \
	--output /tmp/ghostty-shader-harness \
	--shader .config/ghostty/cursor-blaze.glsl \
	--reference /path/to/reference.png
```

The resource reads the cursor shader, builds a raw terminal source texture,
and emits a one-pass shader panel. Pass `--comparison-shader` when an
alternate shader is available. Its default 557x512 canvas and text geometry
can be adjusted with `--lines-file` and the text-position options. Render a
later animation state with `--time 19`.

The generated page uses WebGL2 and declares Ghostty's relevant uniforms. The
current configuration has one `cursor-blaze.glsl` pass; if multiple shaders
are added later, test their configured order separately.

Serve the generated page locally:

```sh
port=8877
nohup python3 -m http.server "$port" --directory /tmp \
	</dev/null >/tmp/ghostty-shader-http.log 2>&1 &
echo $! >/tmp/ghostty-shader-http.pid
```

## Verify with Chrome DevTools MCP

Use the `chrome-devtools` CLI directly; do not start or stop its background
server for each command.

```sh
chrome-devtools new_page \
	'http://localhost:8877/ghostty-shader-repro.html' \
	--timeout 10000
chrome-devtools evaluate_script \
	'() => document.querySelector("#status")?.textContent'
chrome-devtools list_console_messages --types error --pageSize 50
chrome-devtools take_screenshot --fullPage true
```

Require all of the following before trusting a candidate:

- the page reports successful WebGL2 compilation;
- all shader variants render, including the actual multi-pass order;
- there are no shader-related console errors;
- the screenshot is visually compared against the reference at an enlarged
  crop around affected text;
- normal text over dark background remains unchanged.

For local pixel inspection, use the browser's `readPixels` through
`evaluate_script`, or save the MCP screenshot and inspect it with `read`.
Do not infer correctness from a successful `drawArrays` call alone.

## Text compositing guidance

The common failure mode is to recolor `source.rgb` per pixel and then blend it
again with an `ink` value derived from the same antialiased source. Solid glyph
centers and antialiased edges then receive different color transforms, creating
bright halos or dark shadowed glyphs.

For default foreground text, estimate coverage from the known colors:

```glsl
vec3 sourceDelta = source.rgb - iBackgroundColor;
vec3 foregroundDelta = iForegroundColor - iBackgroundColor;
float foregroundEnergy = max(
	dot(foregroundDelta, foregroundDelta),
	0.0001
);
float glyphCoverage = saturate(
	dot(sourceDelta, foregroundDelta) / foregroundEnergy
);
```

Prefer preserving the original glyph color and adding a narrow, low-strength
background outline only where the generated scene is bright. A small
single-pixel neighborhood can be sampled with `glyphCoverage`; avoid a broad
max-mask or a strong opaque matte, which turns dense text into rectangular
blocks. Keep the existing `ink` fallback for colored or otherwise non-default
terminal content unless the source format is fully understood.

## Validate and clean up

Run checks from the repository root:

```sh
git diff --check -- .config/ghostty/*.glsl
/Applications/Ghostty.app/Contents/MacOS/ghostty \
	+validate-config \
	--config-file="$HOME/.config/ghostty/config"
```

If a shader file was changed, reload the Ghostty surface before requesting
another screenshot. If the result is still wrong, capture a new reference
after reload rather than comparing against a stale frame.

Close the temporary Chrome page, stop only the HTTP server created for this
test, and remove generated files. Never kill an unrelated server or browser
session.

## Report

State:

- the reference image path and dimensions;
- the shader order tested (currently one `cursor-blaze.glsl` pass);
- the reproduction harness and Chrome MCP compile/render result;
- the observed artifact and its cause;
- the selected fix and changed shader path (`.config/ghostty/cursor-blaze.glsl`);
- `git diff --check` and Ghostty validation results;
- any remaining uncertainty, especially differences between a reconstructed
  terminal source canvas and the user's exact font/ANSI colors.
