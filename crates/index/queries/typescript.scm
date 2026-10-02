; TypeScript and TSX declarations the bundled queries miss or tag without their doc comment.

(
  (comment)* @doc
  .
  [
    (interface_declaration name: (type_identifier) @name)
    (export_statement declaration: (interface_declaration name: (type_identifier) @name))
  ] @definition.interface
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.interface)
)

(
  (comment)* @doc
  .
  [
    (type_alias_declaration name: (type_identifier) @name)
    (export_statement declaration: (type_alias_declaration name: (type_identifier) @name))
  ] @definition.type
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.type)
)

(
  (comment)* @doc
  .
  [
    (enum_declaration name: (identifier) @name)
    (export_statement declaration: (enum_declaration name: (identifier) @name))
  ] @definition.enum
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.enum)
)

(
  (comment)* @doc
  .
  [
    (abstract_class_declaration name: (type_identifier) @name)
    (export_statement declaration: (abstract_class_declaration name: (type_identifier) @name))
  ] @definition.class
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  [
    (internal_module name: (identifier) @name)
    (export_statement declaration: (internal_module name: (identifier) @name))
  ] @definition.module
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.module)
)

; `handlePress = () => {}` in a class body.
(
  (comment)* @doc
  .
  (public_field_definition
    name: (property_identifier) @name
    value: [(arrow_function) (function_expression)]) @definition.method
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.method)
)
