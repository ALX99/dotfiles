(section_header) @label
(setting_statement) @keyword
(return_statement) @keyword.return
(comment) @comment
(extra_text) @comment
(ellipses) @punctuation.delimiter
(ERROR) @error

; text highlighting
(argument (text) @string)

; Variable highlighting
(variable_name) @variable

; builtins
((variable_name) @constant.builtin
 (#lua-match? @constant.builtin "^EMPTY$"))

((variable_name) @boolean
 (#lua-match? @boolean "^[tT][rR][uU][eE]$"))

((variable_name) @boolean
 (#lua-match? @boolean "^[fF][aA][lL][sS][eE]$"))

((variable_name) @number
 (#lua-match? @number "^[0-9]+$"))

((variable_name) @float
 (#lua-match? @float "^[0-9]+\.[0-9]+$"))

; Parameters
(argument (variable) @parameter)
(keyword_definition (name (argument) @parameter))
(keyword_invocation (keyword (argument) @parameter))

; Keywords
(keyword_definition (body (keyword_setting) @keyword @text.emphasis))
(test_case_or_task_definition (body (test_case_or_task_setting) @keyword @text.emphasis))

; Functions
(keyword_definition (name) @function)
(test_case_or_task_definition (name) @function)
(keyword_invocation (keyword) @function.call)
