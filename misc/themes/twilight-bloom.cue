// Twilight Bloom is the shared palette source for Ghostty, Herdr, and Pi.
//
// Terminal programs consume Ghostty's ANSI palette directly. Herdr and Pi also
// need UI-specific surfaces, so their semantic colors live beside the terminal
// colors here rather than trying to infer them from ANSI slots.
package themes

#PiColors: {
	accent:             "periwinkle"
	border:             "periwinkle"
	borderAccent:       "brightCyan"
	borderMuted:        "dim"
	success:            "mint"
	error:              "rose"
	warning:            "amber"
	muted:              "neutral"
	dim:                "dim"
	text:               "body"
	thinkingText:       "neutral"
	selectedBg:         "selectedBg"
	scrollbarTrack:     "scrollbarTrack"
	scrollbarThumb:     "scrollbarThumb"
	searchMatchBg:      "searchMatchBg"
	searchMatchText:    "searchMatchText"
	userMessageBg:      "userMessageBg"
	userMessageText:    "body"
	customMessageBg:    "customMessageBg"
	customMessageText:  "body"
	customMessageLabel: "orchid"
	toolPendingBg:      "" // Tool rows read as plain text: no tinted band.
	toolSuccessBg:      ""
	toolErrorBg:        ""
	toolTitle:          "body"
	toolOutput:         "body"
	mdHeading:          "amber"
	mdLink:             "periwinkle"
	mdLinkUrl:          "neutral"
	mdCode:             "cyan"
	mdCodeBlock:        "neutral"
	mdCodeBlockBorder:  "periwinkle"
	mdQuote:            "neutral"
	mdQuoteBorder:      "periwinkle"
	mdHr:               "dim"
	mdListBullet:       "cyan"
	toolDiffAdded:      "mint"
	toolDiffRemoved:    "rose"
	toolDiffContext:    "neutral"
	syntaxComment:      "dim"
	syntaxKeyword:      "orchid"
	syntaxFunction:     "periwinkle"
	syntaxVariable:     "neutral"
	syntaxString:       "amber"
	syntaxNumber:       "cyan"
	syntaxType:         "mint"
	syntaxOperator:     "body"
	syntaxPunctuation:  "neutral"
	thinkingOff:        "dim"
	thinkingMinimal:    "cyan"
	thinkingLow:        "periwinkle"
	thinkingMedium:     "orchid"
	thinkingHigh:       "brightCyan"
	thinkingXhigh:      "brightOrchid"
	thinkingMax:        "brightWhite"
	bashMode:           "amber"
}

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
		pi: {
			name: "terminal-dark"
			vars: {
				rose:            9
				mint:            10
				amber:           11
				periwinkle:      12
				orchid:          13
				cyan:            14
				brightCyan:      14
				brightOrchid:    13
				brightWhite:     15
				neutral:         15
				body:            ""
				dim:             "#7b8198"
				selectedBg:      "#5a3b70"
				scrollbarTrack:  "#493755"
				scrollbarThumb:  "#6e5085"
				searchMatchBg:   "#ffd36a"
				searchMatchText: "#22182d"
				userMessageBg:   "#2a1b36"
				customMessageBg: "#231a33"
				toolPendingBg:   "#2c2140"
				toolSuccessBg:   "#173d35"
				toolErrorBg:     "#482136"
			}
			colors: #PiColors
			export: {
				pageBg: "#161821"
				cardBg: "#22182d"
				infoBg: "#35273f"
			}
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
		pi: {
			name: "terminal-light"
			vars: {
				rose:            1
				mint:            2
				amber:           3
				periwinkle:      4
				orchid:          5
				cyan:            6
				brightCyan:      14
				brightOrchid:    13
				brightWhite:     15
				neutral:         "#4a5064"
				body:            "#33374c"
				dim:             "#626878"
				selectedBg:      "#c3cade"
				scrollbarTrack:  "#c9cedb"
				scrollbarThumb:  "#9aa2b8"
				searchMatchBg:   "#ffe08a"
				searchMatchText: "#33374c"
				userMessageBg:   "#dde1ec"
				customMessageBg: "#e2ddec"
				toolPendingBg:   "#dadeee"
				toolSuccessBg:   "#d8e7db"
				toolErrorBg:     "#eedbdf"
			}
			colors: #PiColors
			export: {
				pageBg: "#e8e9ec"
				cardBg: "#dfe2ea"
				infoBg: "#cfd8ea"
			}
		}
	}
}
