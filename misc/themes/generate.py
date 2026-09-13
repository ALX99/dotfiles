#!/usr/bin/env python3
"""Generate Twilight Bloom theme consumers from the CUE palette source."""

from __future__ import annotations

import argparse
import difflib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "misc/themes/twilight-bloom.cue"
PI_SCHEMA = (
	"https://raw.githubusercontent.com/earendil-works/pi/main/packages/"
	"coding-agent/src/modes/interactive/theme/theme-schema.json"
)
HERDR_BEGIN = "# BEGIN GENERATED: Twilight Bloom theme"
HERDR_END = "# END GENERATED: Twilight Bloom theme"


def load_theme() -> dict[str, object]:
	result = subprocess.run(
		["cue", "export", str(SOURCE), "--expression", "theme", "--out", "json"],
		check=True,
		capture_output=True,
		text=True,
	)
	return json.loads(result.stdout)


def ghostty(variant: dict[str, object]) -> str:
	terminal = variant["terminal"]
	assert isinstance(terminal, dict)
	palette = terminal["palette"]
	assert isinstance(palette, list)
	lines = [
		f"background = {terminal['background']}",
		f"foreground = {terminal['foreground']}",
		f"selection-background = {terminal['selectionBackground']}",
		f"selection-foreground = {terminal['selectionForeground']}",
		f"cursor-color = {terminal['cursorColor']}",
		f"cursor-text = {terminal['cursorText']}",
	]
	lines.extend(f"palette = {index}={colour}" for index, colour in enumerate(palette))
	return "\n".join(lines) + "\n"


def pi(variant: dict[str, object]) -> str:
	theme = variant["pi"]
	assert isinstance(theme, dict)
	return json.dumps({"$schema": PI_SCHEMA, **theme}, indent=2) + "\n"


def herdr_block(theme: dict[str, object]) -> str:
	lines = [
		HERDR_BEGIN,
		"# Generated from misc/themes/twilight-bloom.cue; do not edit here.",
	]
	for appearance in ("dark", "light"):
		variant = theme[appearance]
		assert isinstance(variant, dict)
		herdr = variant["herdr"]
		assert isinstance(herdr, dict)
		lines.extend(
			[
				f"[theme.custom.{appearance}]",
				f'text = "{herdr["text"]}"',
				f'overlay1 = "{herdr["overlay1"]}"',
				f'subtext0 = "{herdr["subtext0"]}"',
				f'overlay0 = "{herdr["overlay0"]}"',
				f'active_row_bg = "{herdr["activeRowBg"]}"',
				f'selection_bg = "{herdr["selectionBg"]}"',
				f'mauve = "{herdr["mauve"]}"',
			]
		)
		lines.append("")
	lines.extend([HERDR_END, ""])
	return "\n".join(lines)


def herdr(theme: dict[str, object]) -> str:
	path = ROOT / ".config/herdr/config.toml"
	current = path.read_text()
	try:
		before, remainder = current.split(HERDR_BEGIN, maxsplit=1)
		_, after = remainder.split(HERDR_END, maxsplit=1)
	except ValueError as error:
		raise ValueError(f"{path} is missing generated-theme markers") from error
	return before + herdr_block(theme) + after.lstrip("\n")


def outputs(theme: dict[str, object]) -> dict[Path, str]:
	dark = theme["dark"]
	light = theme["light"]
	assert isinstance(dark, dict) and isinstance(light, dict)
	return {
		ROOT / ".config/ghostty/themes/twilight-bloom": ghostty(dark),
		ROOT / ".config/ghostty/themes/twilight-bloom-light": ghostty(light),
		ROOT / "home/.pi/agent/themes/terminal-dark.json": pi(dark),
		ROOT / "home/.pi/agent/themes/terminal-light.json": pi(light),
		ROOT / ".config/herdr/config.toml": herdr(theme),
	}


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--check", action="store_true", help="fail if outputs differ")
	args = parser.parse_args()

	different = False
	for path, expected in outputs(load_theme()).items():
		actual = path.read_text()
		if actual == expected:
			continue
		different = True
		if args.check:
			sys.stdout.writelines(
				difflib.unified_diff(
					actual.splitlines(keepends=True),
					expected.splitlines(keepends=True),
					fromfile=str(path),
					tofile=f"{path} (generated)",
				)
			)
		else:
			path.write_text(expected)
	if args.check and different:
		return 1
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
