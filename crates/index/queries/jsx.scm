; A component rendered as `<Name …>`; lowercase names are HTML elements.

(jsx_opening_element
  name: (identifier) @name
  (#match? @name "^[A-Z]")) @reference.call

(jsx_self_closing_element
  name: (identifier) @name
  (#match? @name "^[A-Z]")) @reference.call
