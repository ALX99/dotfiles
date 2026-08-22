// This is the source of truth for .config/karabiner/karabiner.json.
// Run `mise run karabiner:gen` after editing this file.
package karabiner

#InputSourceCondition: {
	type: "input_source_if" | "input_source_unless"
	input_sources: [...{
		input_source_id: string
	}]
}

#KeyAction: {
	key_code: string
	modifiers?: [...string]
	conditions?: [...#InputSourceCondition]
}

_colemakInputSource: {
	input_source_id: "^org\\.unknown\\.keylayout\\.Colemak-DHANSI$"
}

_symbolLayerCondition: {
	type:  "variable_if"
	name:  "symbol_layer"
	value: 1
}

_emojiLayerCondition: {
	type:  "variable_if"
	name:  "emoji_layer"
	value: 1
}

_chromiumCondition: {
	bundle_identifiers: [
		"^com\\.google\\.Chrome$",
		"^com\\.brave\\.Browser$",
	]
	type: "frontmost_application_if"
}

#ColemakAction: #KeyAction & {
	key_code: string
}

#ColemakAwareActions: {
	standard: #ColemakAction
	colemak:  #ColemakAction
	actions: [
		standard & {
			conditions: [{
				type: "input_source_unless"
				input_sources: [_colemakInputSource]
			}]
		},
		colemak & {
			conditions: [{
				type: "input_source_if"
				input_sources: [_colemakInputSource]
			}]
		},
	]
}

#SymbolMapping: {
	from: string
	actions: [...#KeyAction]
}

// Maps logical letters to the physical key codes in Colemak-DH ANSI.
// Keep this aligned with misc/keymaps/Colemak-DH-ANSI.keylayout.
_colemakDHKeyCodes: {
	a: "a"
	b: "t"
	c: "x"
	d: "c"
	e: "k"
	f: "e"
	g: "g"
	h: "m"
	i: "l"
	j: "y"
	k: "n"
	l: "u"
	m: "h"
	n: "j"
	o: "semicolon"
	p: "r"
	q: "q"
	r: "s"
	s: "d"
	t: "f"
	u: "i"
	v: "v"
	w: "w"
	x: "z"
	y: "o"
	z: "b"
}

#ColemakKey: {
	letter: string
	sources: [
		{
			key: letter
			condition: {
				type: "input_source_unless"
				input_sources: [_colemakInputSource]
			}
		},
		{
			key: _colemakDHKeyCodes[letter]
			condition: {
				type: "input_source_if"
				input_sources: [_colemakInputSource]
			}
		},
	]
}

#ClipboardShortcut: {
	label:   string
	trigger: #ColemakKey
	command: string
	...
	actions: [
		{
			shell_command:          command
			hold_down_milliseconds: 200
		},
		{
			key_code: "v"
			modifiers: ["left_command"]
		},
	]
}

#StaticTextShortcut: #ClipboardShortcut & {
	text:    string
	command: "/bin/echo -n '\(text)' | LANG=en_US.UTF-8 /usr/bin/pbcopy"
}

#ISODateShortcut: #ClipboardShortcut & {
	label:   "Current date"
	command: "/bin/date +%F | /usr/bin/tr -d '\\n' | /usr/bin/pbcopy"
}

_symbolMappings: [...#SymbolMapping] & [
	{from: "q", actions: [{key_code: "1", modifiers: ["left_shift"]}]},
	{from: "w", actions: [{key_code: "slash", modifiers: ["left_shift"]}]},
	{from: "e", actions: [{key_code: "equal_sign"}]},
	{from: "r", actions: [{key_code: "hyphen"}]},
	{from: "t", actions: [{key_code: "period", modifiers: ["left_shift"]}]},
	{from: "y", actions: [{key_code: "equal_sign", modifiers: ["left_shift"]}]},
	{from: "u", actions: [{key_code: "backslash", modifiers: ["left_shift"]}]},
	{from: "i", actions: [{key_code: "7", modifiers: ["left_shift"]}]},
	{from: "o", actions: [{key_code: "comma", modifiers: ["left_shift"]}]},
	{
		from: "a"
		actions: (#ColemakAwareActions & {
			standard: {key_code: "semicolon", modifiers: ["left_shift"]}
			colemak: {key_code: "p", modifiers: ["left_shift"]}
		}).actions
	},
	{from: "s", actions: [{key_code: "hyphen", modifiers: ["left_shift"]}]},
	{from: "d", actions: [{key_code: "9", modifiers: ["left_shift"]}]},
	{from: "f", actions: [{key_code: "0", modifiers: ["left_shift"]}]},
	{from: "g", actions: [{key_code: "quote", modifiers: ["left_shift"]}]},
	{from: "h", actions: [{key_code: "left_arrow"}]},
	{from: "j", actions: [{key_code: "down_arrow"}]},
	{from: "k", actions: [{key_code: "up_arrow"}]},
	{from: "l", actions: [{key_code: "right_arrow"}]},
	{from: "z", actions: [{key_code: "4", modifiers: ["left_shift"]}]},
	{from: "x", actions: [{key_code: "open_bracket", modifiers: ["left_shift"]}]},
	{from: "c", actions: [{key_code: "close_bracket", modifiers: ["left_shift"]}]},
	{from: "v", actions: [{key_code: "8", modifiers: ["left_shift"]}]},
	{from: "b", actions: [{key_code: "grave_accent_and_tilde", modifiers: ["left_shift"]}]},
	{from: "n", actions: [{key_code: "5", modifiers: ["left_shift"]}]},
	{
		from: "m"
		actions: (#ColemakAwareActions & {
			standard: {key_code: "semicolon"}
			colemak: {key_code: "p"}
		}).actions
	},
	{from: "comma", actions: [{key_code: "home"}]},
	{from: "period", actions: [{key_code: "end"}]},
	{from: "spacebar", actions: [{key_code: "delete_or_backspace"}]},
	{from: "p", actions: [{key_code: "2", modifiers: ["left_shift"]}]},
	{from: "quote", actions: [{key_code: "6", modifiers: ["left_shift"]}]},
	{from: "open_bracket", actions: [{key_code: "3", modifiers: ["left_shift"]}]},
	{from: "close_bracket", actions: [{key_code: "grave_accent_and_tilde"}]},
]

_clipboardShortcuts: [...#ClipboardShortcut] & [
	#StaticTextShortcut & {
		label: "Thumbs up"
		trigger: {letter: "y"}
		text: "👍"
	},
	#ISODateShortcut & {
		trigger: {letter: "d"}
	},
	#StaticTextShortcut & {
		label: "LGTM"
		trigger: {letter: "l"}
		text: "LGTM"
	},
]

#ChromiumTarget: {
	key:       string
	modifier?: "left_shift" | "left_option"
	layout:    *"any" | "standard" | "colemak"
	action: {
		key_code: key
		modifiers: [
			"left_command",
			if modifier != _|_ {
				modifier
			},
		]
	}
}

_standardLayoutAction: {
	conditions: [{
		type: "input_source_unless"
		input_sources: [_colemakInputSource]
	}]
}

_colemakLayoutAction: {
	conditions: [{
		type: "input_source_if"
		input_sources: [_colemakInputSource]
	}]
}

#ChromiumCommand: {
	label: string
	key:   string
	mandatory: *["left_command"] | [...string]
	optional: *[] | [...string]
	targets: [...#ChromiumTarget]
	actions: [
		for target in targets {
			if target.layout == "any" {
				target.action
			}
			if target.layout == "standard" {
				target.action & _standardLayoutAction
			}
			if target.layout == "colemak" {
				target.action & _colemakLayoutAction
			}
		},
	]
}

_chromiumCommands: [...#ChromiumCommand] & [
	{
		label: "Command + / → Search"
		key:   "slash"
		targets: [{key: "a", modifier: "left_shift"}]
	},
	{
		label: "Navigate to the previous in history"
		key:   "h"
		targets: [{key: "left_arrow"}]
	},
	{
		label: "Navigate to next page in history"
		key:   "l"
		targets: [{key: "right_arrow"}]
	},
	{
		label: "Go to previous tab"
		key:   "k"
		targets: [{key: "left_arrow", modifier: "left_option"}]
	},
	{
		label: "Go to next tab"
		key:   "j"
		targets: [{key: "right_arrow", modifier: "left_option"}]
	},
	{
		label: "Close current tab"
		key:   "z"
		targets: [{key: "w"}]
	},
	{
		label: "Reopen closed tab"
		key:   "z"
		mandatory: ["left_command", "right_shift"]
		targets: [
			{key: "t", modifier: "left_shift", layout: "standard"},
			{key: "f", modifier: "left_shift", layout: "colemak"},
		]
	},
	{
		label: "Jump to address bar"
		key:   "d"
		targets: [
			{key: "l", layout: "standard"},
			{key: "u", layout: "colemak"},
		]
	},
	{
		label: "Reload page"
		key:   "s"
		optional: ["left_shift", "right_shift"]
		targets: [
			{key: "r", layout: "standard"},
			{key: "s", layout: "colemak"},
		]
	},
]

config: {
	profiles: [
		{
			complex_modifications: {
				rules: [
					for activator in [
						{
							description: "Caps Lock: symbol layer when held, Backspace when tapped."
							key:         "caps_lock"
						},
						{
							description: "Physical P: symbol layer when held, Backspace when tapped."
							key:         "p"
						},
					] {
						manipulators: [{
							description: activator.description
							from: {
								key_code: activator.key
								modifiers: {
									optional: ["any"]
								}
							}
							to: [{
								set_variable: {
									name:  "symbol_layer"
									value: 1
								}
							}]
							to_after_key_up: [{
								set_variable: {
									name:  "symbol_layer"
									value: 0
								}
							}]
							to_if_alone: [{
								key_code: "delete_or_backspace"
							}]
							type: "basic"
						}]
					},
					{
						manipulators: [{
							description: "Tab to command+control+option."
							from: {
								key_code: "tab"
								modifiers: {
									optional: ["any"]
								}
							}
							to: [{
								key_code: "left_option"
								modifiers: ["left_command", "left_control"]
							}]
							to_if_alone: [{
								key_code: "tab"
							}]
							type: "basic"
						}]
					},
					{
						description: "Both Shifts -> Toggle Caps Lock"
						manipulators: [{
							from: {
								modifiers: {
									optional: ["any"]
								}
								simultaneous: [
									{key_code: "left_shift"},
									{key_code: "right_shift"},
								]
								simultaneous_options: {
									detect_key_down_uninterruptedly: true
									key_down_order:                  "insensitive"
									key_up_order:                    "insensitive"
								}
							}
							parameters: {
								"basic.simultaneous_threshold_milliseconds": 100
							}
							to: [{
								key_code: "caps_lock"
							}]
							type: "basic"
						}]
					},
					{
						description: "Comma + Period -> Enter"
						manipulators: [{
							from: {
								modifiers: {
									optional: ["any"]
								}
								simultaneous: [
									{key_code: "comma"},
									{key_code: "period"},
								]
								simultaneous_options: {
									detect_key_down_uninterruptedly: true
									key_down_order:                  "insensitive"
									key_up_order:                    "insensitive"
								}
							}
							parameters: {
								"basic.simultaneous_threshold_milliseconds": 100
							}
							to: [{
								key_code: "return_or_enter"
							}]
							type: "basic"
						}]
					},
					{
						description: "Emoji layer: hold Caps Lock + Space."
						manipulators: [{
							from: {
								key_code: "spacebar"
								modifiers: {
									optional: ["any"]
								}
							}
							to: [{
								set_variable: {
									name:  "emoji_layer"
									value: 1
								}
							}]
							to_after_key_up: [{
								set_variable: {
									name:  "emoji_layer"
									value: 0
								}
							}]
							to_if_alone: [{
								key_code: "delete_or_backspace"
							}]
							type: "basic"
							conditions: [_symbolLayerCondition]
						}]
					},
					{
						description: "Clipboard shortcuts"
						manipulators: [
							for shortcut in _clipboardShortcuts for source in shortcut.trigger.sources {
								{
									from: {
										key_code: source.key
									}
									to:   shortcut.actions
									type: "basic"
									conditions: [
										_emojiLayerCondition,
										source.condition,
									]
								}
							},
						]
					},
					{
						description: "Symbol layer"
						manipulators: [
							for mapping in _symbolMappings {
								{
									from: {
										key_code: mapping.from
									}
									to:   mapping.actions
									type: "basic"
									conditions: [_symbolLayerCondition]
								}
							},
						]
					},
					for command in _chromiumCommands {
						{
							description: "Chromium browsers: \(command.label)"
							manipulators: [{
								conditions: [_chromiumCondition]
								from: {
									key_code: command.key
									modifiers: {
										mandatory: command.mandatory
										optional:  command.optional
									}
								}
								to:   command.actions
								type: "basic"
							}]
						}
					},
				]
			}
			devices: [
				{
					identifiers: {
						is_keyboard: true
					}
					simple_modifications: []
				},
				{
					identifiers: {
						is_keyboard:        true
						is_pointing_device: true
					}
					ignore: false
					simple_modifications: []
				},
				{
					identifiers: {
						is_keyboard: true
						product_id:  24814
						vendor_id:   6127
					}
					simple_modifications: []
				},
			]
			name:     "Customized colemak"
			selected: true
			virtual_hid_keyboard: {
				country_code:     0
				keyboard_type_v2: "ansi"
			}
		},
		{
			name: "Empty profile"
			virtual_hid_keyboard: {
				country_code: 0
			}
		},
	]
}
