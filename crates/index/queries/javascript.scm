; `handlePress = () => {}` in a class body.
(
  (comment)* @doc
  .
  (field_definition
    property: (property_identifier) @name
    value: [(arrow_function) (function_expression)]) @definition.method
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.method)
)
