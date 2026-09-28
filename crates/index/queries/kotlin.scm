; Written for Brigadier's static index. tree-sitter-kotlin-ng does not ship a tags query.
(class_declaration name: (identifier) @name) @definition.class
(function_declaration name: (identifier) @name) @definition.function
(object_declaration name: (identifier) @name) @definition.module
(property_declaration (variable_declaration (identifier) @name)) @definition.property
(user_type (identifier) @name) @reference.type
