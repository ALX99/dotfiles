// Twilight Bloom is the shared palette source for Ghostty and Herdr.
//
// Terminal programs consume Ghostty's ANSI palette directly. Herdr also needs
// UI-specific surfaces, so its semantic colors live beside the terminal colors
// rather than trying to infer them from ANSI slots.
package themes

theme: {
	dark: {
		terminal: {
			background:          "#3a3a3a"
			foreground:          "#d0d0d0"
			selectionBackground: "#005f5f"
			selectionForeground: "#d0d0d0"
			cursorColor:         "#d0d0d0"
			cursorText:          "#3a3a3a"
			palette: [
				"#4e4e4e", "#d68787", "#5f865f", "#d8af5f",
				"#85add4", "#d7afaf", "#87afaf", "#d0d0d0",
				"#626262", "#d75f87", "#87af87", "#ffd787",
				"#add4fb", "#ffafaf", "#87d7d7", "#e4e4e4",
			]
		}
		herdr: {
			text:     terminal.foreground
			overlay1: terminal.foreground
			// Herdr's dense sidebar needs a brighter muted hierarchy than a
			// terminal's ANSI dim slot, and a restrained selection surface.
			subtext0:    "#a8a8a8"
			overlay0:    "#a8a8a8"
			activeRowBg: "#4e4e4e"
			selectionBg: "#4e4e4e"
			mauve:       terminal.palette[13]
		}
	}

	light: {
		terminal: {
			background:          "#dadada"
			foreground:          "#4e4e4e"
			selectionBackground: "#afd7d7"
			selectionForeground: "#4e4e4e"
			cursorColor:         "#4e4e4e"
			cursorText:          "#dadada"
			palette: [
				"#4e4e4e", "#af5f5f", "#5f885f", "#af8760",
				"#5f87ae", "#875f87", "#5f8787", "#e4e4e4",
				"#3a3a3a", "#870100", "#005f00", "#d8865f",
				"#0087af", "#87025f", "#008787", "#eeeeee",
			]
		}
		herdr: {
			text:        terminal.foreground
			overlay1:    terminal.foreground
			subtext0:    terminal.palette[8]
			overlay0:    terminal.palette[8]
			activeRowBg: terminal.selectionBackground
			selectionBg: terminal.selectionBackground
			mauve:       terminal.palette[5]
		}
	}
}
