#!/usr/bin/env python3
"""Build a browser-based Ghostty custom-shader reproduction harness."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


DEFAULT_LINES = [
	"s close_page 3 >/dev/null 2>&1 || true",
	"s close_page 2 >/dev/null 2>&1 || true",
	"v/null || true",
	"r-http.pid /tmp/shader-http.log /",
	"line.html /tmp/shader-pipeline.js",
	"clipboard-up.png /tmp/pi-clipboard-",
	"d-latest-text.png /tmp/harness-compare",
	"threshold-compare.png (timeout 30s)",
]


def resolve_path(root: Path, path: Path) -> Path:
	return path if path.is_absolute() else root / path


def html_document(
	scene_source: str,
	baseline_source: str | None,
	scene_label: str,
	baseline_label: str | None,
	width: int,
	height: int,
	lines: list[str],
	font_size: int,
	text_x: int,
	text_start_y: int,
	text_step_y: int,
	shader_time: float,
	reference_name: str | None,
) -> str:
	background = [31 / 255, 31 / 255, 40 / 255]
	foreground = [215 / 255, 215 / 255, 215 / 255]
	reference_markup = ""
	if reference_name is not None:
		reference_markup = f"""
	const referenceFigure = document.createElement("figure");
	const referenceImage = new Image();
	const referenceCaption = document.createElement("figcaption");
	referenceImage.src = {json.dumps(reference_name)};
	referenceImage.alt = "Reference screenshot";
	referenceCaption.textContent = "Reference screenshot";
	referenceFigure.append(referenceImage, referenceCaption);
	document.querySelector(".row").append(referenceFigure);
"""
	baseline_panel = ""
	if baseline_source is not None and baseline_label is not None:
		baseline_panel = f"""
	addPanel({json.dumps(baseline_label)}, (gl) => {{
		drawSingle(baselineSource, null, gl);
	}});
"""

	return f"""<!doctype html>
<meta charset="utf-8">
<title>Ghostty shader reproduction</title>
<link rel="icon" href="data:,">
<style>
	body {{
		margin: 0;
		background: #222;
		color: #fff;
		font: 14px monospace;
	}}
	#status {{
		padding: 8px;
		white-space: pre-wrap;
	}}
	.row {{
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		padding: 0 12px 12px;
	}}
	figure {{
		margin: 0;
	}}
	canvas, img {{
		width: {width}px;
		height: {height}px;
		display: block;
		border: 1px solid #666;
	}}
	figcaption {{
		padding: 5px 0;
	}}
</style>
<div id="status">Compiling Ghostty shader...</div>
<div class="row"></div>
<script>
const sceneSource = {json.dumps(scene_source)};
const baselineSource = {json.dumps(baseline_source)};
const terminalLines = {json.dumps(lines)};
const W = {width};
const H = {height};
const shaderTime = {shader_time!r};
const background = {json.dumps(background)};
const foreground = {json.dumps(foreground)};

const vertexSource = `#version 300 es
precision highp float;
const vec2 positions[3] = vec2[3](
	vec2(-1.0, -1.0),
	vec2(3.0, -1.0),
	vec2(-1.0, 3.0)
);
void main() {{
	gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}}`;

function sourceCanvas() {{
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const context = canvas.getContext("2d");
	context.fillStyle = "#1f1f28";
	context.fillRect(0, 0, W, H);
	context.font = '{font_size}px "Departure Mono", monospace';
	context.textBaseline = "top";
	context.fillStyle = "#d7d7d7";
	terminalLines.forEach((line, index) => {{
		context.fillText(line, {text_x}, {text_start_y} + index * {text_step_y});
	}});
	return canvas;
}}

function compileShader(gl, type, source) {{
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {{
		throw new Error(gl.getShaderInfoLog(shader));
	}}
	return shader;
}}

function makeProgram(gl, source, extraUniforms = "") {{
	const fragmentSource = `#version 300 es
precision highp float;
uniform float iTime;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform vec3 iBackgroundColor;
uniform vec3 iForegroundColor;
${{extraUniforms}}
out vec4 outputColor;
${{source}}
void main() {{
	mainImage(outputColor, gl_FragCoord.xy);
}}`;
	const program = gl.createProgram();
	gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
	gl.attachShader(
		program,
		compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource),
	);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {{
		throw new Error(gl.getProgramInfoLog(program));
	}}
	return program;
}}

function makeTexture(gl, input) {{
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	if (input) {{
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			input,
		);
	}} else {{
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA,
			W,
			H,
			0,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			null,
		);
	}}
	return texture;
}}

function makeFramebuffer(gl, texture) {{
	const framebuffer = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(
		gl.FRAMEBUFFER,
		gl.COLOR_ATTACHMENT0,
		gl.TEXTURE_2D,
		texture,
		0,
	);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {{
		throw new Error("framebuffer is incomplete");
	}}
	return framebuffer;
}}

function setUniforms(gl, program) {{
	gl.uniform1i(gl.getUniformLocation(program, "iChannel0"), 0);
	gl.uniform1f(gl.getUniformLocation(program, "iTime"), shaderTime);
	gl.uniform3f(gl.getUniformLocation(program, "iResolution"), W, H, 1);
	gl.uniform3f(
		gl.getUniformLocation(program, "iBackgroundColor"),
		...background,
	);
	gl.uniform3f(
		gl.getUniformLocation(program, "iForegroundColor"),
		...foreground,
	);
}}

function setCursorUniforms(gl, program) {{
	const cursor = gl.getUniformLocation(program, "iCurrentCursor");
	if (!cursor) {{
		return;
	}}
	gl.uniform4f(cursor, W - 80, H / 2, 2, 30);
	gl.uniform4f(
		gl.getUniformLocation(program, "iPreviousCursor"),
		W - 80,
		H / 2,
		2,
		30,
	);
	gl.uniform1f(
		gl.getUniformLocation(program, "iTimeCursorChange"),
		0,
	);
}}

function drawPass(gl, program, input, framebuffer) {{
	gl.useProgram(program);
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, input);
	setUniforms(gl, program);
	setCursorUniforms(gl, program);
	gl.viewport(0, 0, W, H);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
}}

function addPanel(label, draw) {{
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const figure = document.createElement("figure");
	const caption = document.createElement("figcaption");
	caption.textContent = label;
	figure.append(canvas, caption);
	document.querySelector(".row").append(figure);
	const gl = canvas.getContext("webgl2", {{ preserveDrawingBuffer: true }});
	if (!gl) {{
		throw new Error("WebGL2 is unavailable");
	}}
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
	draw(gl, canvas);
}}

function drawSingle(source, outputCanvas, gl) {{
	const input = makeTexture(gl, sourceCanvas());
	const program = makeProgram(
		gl,
		source,
		"uniform vec4 iCurrentCursor; uniform vec4 iPreviousCursor; uniform float iTimeCursorChange;",
	);
	drawPass(gl, program, input, null);
}}

try {{
{baseline_panel}
	addPanel("Shader: {scene_label}", (gl) => {{
		drawSingle(sceneSource, null, gl);
	}});
{reference_markup}
	document.querySelector("#status").textContent =
		"WebGL2 compiled and rendered the shader.";
}} catch (error) {{
	document.querySelector("#status").textContent = "ERROR: " + error.stack;
	console.error(error);
}}
</script>
"""


def main() -> None:
	parser = argparse.ArgumentParser(
		description="Build a Chrome WebGL2 harness for Ghostty custom shaders.",
	)
	parser.add_argument(
		"--root",
		type=Path,
		default=Path.cwd(),
		help="repository root (default: current directory)",
	)
	parser.add_argument(
		"--output",
		type=Path,
		default=Path("/tmp/ghostty-shader-harness"),
		help="directory for the generated page",
	)
	parser.add_argument(
		"--reference",
		type=Path,
		help="optional reference image to display beside the variants",
	)
	parser.add_argument(
		"--shader",
		type=Path,
		help=(
			"target shader path, relative to --root when not absolute "
			"(default: .config/ghostty/cursor-blaze.glsl)"
		),
	)
	parser.add_argument(
		"--comparison-shader",
		type=Path,
		help=(
			"optional shader to show as a single-pass comparison, relative "
			"to --root when not absolute"
		),
	)
	parser.add_argument("--width", type=int, default=557)
	parser.add_argument("--height", type=int, default=512)
	parser.add_argument(
		"--lines-file",
		type=Path,
		help="text lines to draw into the raw terminal source texture",
	)
	parser.add_argument("--font-size", type=int, default=24)
	parser.add_argument("--text-x", type=int, default=-40)
	parser.add_argument("--text-start-y", type=int, default=92)
	parser.add_argument("--text-step-y", type=int, default=39)
	parser.add_argument(
		"--time",
		type=float,
		default=0.0,
		help="iTime value in seconds to render (default: 0)",
	)
	args = parser.parse_args()

	scene_path = resolve_path(
		args.root,
		args.shader or Path(".config/ghostty/cursor-blaze.glsl"),
	)
	scene_source = scene_path.read_text()
	baseline_source = None
	baseline_label = None
	if args.comparison_shader:
		comparison_path = resolve_path(args.root, args.comparison_shader)
		baseline_source = comparison_path.read_text()
		baseline_label = f"Comparison: {comparison_path.stem} only"
	lines = (
		args.lines_file.read_text().splitlines()
		if args.lines_file
		else DEFAULT_LINES
	)
	reference_name = None
	args.output.mkdir(parents=True, exist_ok=True)
	if args.reference:
		reference_name = "reference" + args.reference.suffix.lower()
		shutil.copy2(args.reference, args.output / reference_name)

	page = html_document(
		scene_source,
		baseline_source,
		scene_path.stem,
		baseline_label,
		args.width,
		args.height,
		lines,
		args.font_size,
		args.text_x,
		args.text_start_y,
		args.text_step_y,
		args.time,
		reference_name,
	)
	page_path = args.output / "ghostty-shader-repro.html"
	page_path.write_text(page)
	print(page_path)
	if reference_name:
		print(args.output / reference_name)


if __name__ == "__main__":
	main()
