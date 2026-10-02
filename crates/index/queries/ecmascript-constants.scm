; TypeScript and JavaScript, after every other pattern: a top-level `const` that is not
; tagged as something else (a store, a styled component, a config object, a `memo(…)`).
; `(comment)*` inside `(program …)` stops matching after the file's first comment, so the
; comment before it is taken alone, and a constant without one comes last.

(program
  (comment) @doc
  .
  [
    (lexical_declaration
      kind: "const"
      (variable_declarator name: (identifier) @name))
    (export_statement
      declaration: (lexical_declaration
        kind: "const"
        (variable_declarator name: (identifier) @name)))
  ] @definition.constant
  (#select-adjacent! @doc @definition.constant)
)

(program
  [
    (lexical_declaration
      kind: "const"
      (variable_declarator name: (identifier) @name))
    (export_statement
      declaration: (lexical_declaration
        kind: "const"
        (variable_declarator name: (identifier) @name)))
  ] @definition.constant
)
