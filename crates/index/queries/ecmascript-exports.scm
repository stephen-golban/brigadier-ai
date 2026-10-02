; TypeScript and JavaScript, ahead of the bundled queries. A doc comment sits before `export`,
; not before the declaration inside it, so the bundled patterns see none; these come first so
; their tag wins.

(
  (comment)* @doc
  .
  (export_statement
    declaration: [
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
    ]) @definition.function
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (export_statement
    declaration: (class_declaration name: (_) @name)) @definition.class
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  (export_statement
    declaration: (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression)]))) @definition.function
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)
