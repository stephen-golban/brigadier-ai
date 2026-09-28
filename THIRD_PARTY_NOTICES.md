# Third-party notices

- `apps/desktop/src/components/ui/`, `apps/desktop/src/components/assistant-ui/`, `apps/desktop/src/hooks/use-copy-to-clipboard.ts` and the token values in `apps/desktop/src/styles/tokens.css` are adapted from [assistant-ui](https://github.com/assistant-ui/assistant-ui) (MIT, Copyright (c) 2025 AgentbaseAI Inc.), radix flavor, commit `3ca2fb35619661e9941d5782f4beb08c1f83d5f5`.
- `crates/index/queries/csharp.scm` adapts the tags query from [tree-sitter-c-sharp](https://github.com/tree-sitter/tree-sitter-c-sharp) 0.23.5 (MIT).
- `crates/index/queries/swift.scm` adapts the tags query from [tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift) 0.7.3 (MIT).
- The Brain's embedding model, [minishlab/potion-retrieval-32M](https://huggingface.co/minishlab/potion-retrieval-32M) (MIT), revision `6fc8051fab2a1e0ee76689cf08c853792ac285e7`, is downloaded at runtime into the data folder, not shipped. `crates/brain/src/embed.rs` computes its embeddings the way [Model2Vec](https://github.com/MinishLab/model2vec) (MIT) does; no code is taken from it.
