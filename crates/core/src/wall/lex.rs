//! A Bash tokeniser that stops at a published boundary.
//!
//! It splits a command line into words, command separators and redirection operators, resolving
//! quoting and backslash escapes so that `\cat`, `"cat"` and `cat` all come out as the word
//! `cat`. It does **not** evaluate: `$VAR` is left as literal text with [`Word::expanded`] set,
//! and `$(…)` / backticks are swallowed whole as one word with [`Word::substitution`] set. That
//! limit — no variable expansion, no `$(…)`, no subshells — is [`super`]'s, and it is recorded
//! here rather than papered over.
//!
//! Two consequences worth naming, because both are silent:
//!
//! * A heredoc **body** is not tracked. `cat <<EOF` followed by lines of text lexes those lines as
//!   if they were commands. That can only add segments, and [`super::bash::classify`] takes the
//!   strictest segment, so the error is always toward refusing — never toward allowing.
//! * An unterminated quote is closed at end of input rather than reported. A classifier that
//!   returns nothing on malformed input would be a hole; a classifier that guesses conservatively
//!   is not.

/// A command separator. `(` and `)` are separators too: the words on either side are different
/// commands, which is all the classifier needs from a subshell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sep {
    /// `;` (and `;;`).
    Semi,
    /// `&&`.
    AndAnd,
    /// `||`.
    OrOr,
    /// `|` or `|&`.
    Pipe,
    /// `&` — background.
    Amp,
    /// A literal newline.
    Newline,
    /// `(`.
    OpenGroup,
    /// `)`.
    CloseGroup,
}

/// A redirection operator. A leading file descriptor (`2>`) is consumed and discarded: which fd is
/// redirected does not change whether a file is written.
// The three rules that matter here are quoted from `man bash` on this machine (bash 3.2, macOS),
// section REDIRECTION: `[n]>&word` duplicates "if word expands to one or more digits" and closes
// the fd if word is `-`, but "if n is omitted, and word does not expand to one or more digits, the
// standard output and standard error are redirected" *to that file*; `<<-` only "strips leading
// tab characters"; and a simple command is "a sequence of optional variable assignments followed
// by blank-separated words and redirections", which is why `FOO=1 cat x` runs `cat`. `|&` is bash
// 4.0+ and is not in the 3.2 page — it is handled as a pipe here on assertion, not measurement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redir {
    /// `>` or `>|`.
    Out,
    /// `>>`.
    OutAppend,
    /// `&>` or `&>>` — stdout and stderr to a file.
    OutErr,
    /// `>&` — a duplication when the target is a number (`2>&1`), a file write otherwise.
    OutDup,
    /// `<`.
    In,
    /// `<&`.
    InDup,
    /// `<<` — the delimiter follows; the body is not tracked.
    Heredoc,
    /// `<<<`.
    HereString,
    /// `<>` — opens the target for reading and writing.
    ReadWrite,
}

/// One word, with quoting resolved and expansions flagged rather than performed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Word {
    /// The word with quotes and escapes removed. `$VAR` survives verbatim, unexpanded.
    pub text: String,
    /// The word contained an unquoted `$` or a backtick — its real value is not known here.
    pub expanded: bool,
    /// The word contained `$(…)` or a backtick command substitution, swallowed whole. Anything
    /// could be in there, so a segment carrying one is never better than `Unknown`.
    pub substitution: bool,
}

/// One token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tok {
    /// A word.
    Word(Word),
    /// A command separator.
    Sep(Sep),
    /// A redirection operator; the target, if any, is the next [`Tok::Word`].
    Redir(Redir),
}

/// Tokenise one command line. Never fails: malformed input yields whatever was readable.
pub fn lex(line: &str) -> Vec<Tok> {
    let src: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < src.len() {
        match src[i] {
            ' ' | '\t' | '\r' => i += 1,
            '\n' => {
                out.push(Tok::Sep(Sep::Newline));
                i += 1;
            }
            // A `#` only opens a comment at the start of a word, which is exactly where we are:
            // whitespace has just been skipped. `foo#bar` is read as one word by `read_word`.
            '#' => {
                while i < src.len() && src[i] != '\n' {
                    i += 1;
                }
            }
            ';' => {
                i += 1;
                if src.get(i) == Some(&';') {
                    i += 1;
                }
                out.push(Tok::Sep(Sep::Semi));
            }
            '(' => {
                out.push(Tok::Sep(Sep::OpenGroup));
                i += 1;
            }
            ')' => {
                out.push(Tok::Sep(Sep::CloseGroup));
                i += 1;
            }
            '&' => match src.get(i + 1) {
                Some('&') => {
                    out.push(Tok::Sep(Sep::AndAnd));
                    i += 2;
                }
                Some('>') => {
                    i += 2;
                    if src.get(i) == Some(&'>') {
                        i += 1;
                    }
                    out.push(Tok::Redir(Redir::OutErr));
                }
                _ => {
                    out.push(Tok::Sep(Sep::Amp));
                    i += 1;
                }
            },
            '|' => match src.get(i + 1) {
                Some('|') => {
                    out.push(Tok::Sep(Sep::OrOr));
                    i += 2;
                }
                // `|&` is a pipe that also carries stderr; for classification it is a pipe.
                Some('&') => {
                    out.push(Tok::Sep(Sep::Pipe));
                    i += 2;
                }
                _ => {
                    out.push(Tok::Sep(Sep::Pipe));
                    i += 1;
                }
            },
            '<' | '>' => {
                let (r, next) = read_redir(&src, i);
                out.push(Tok::Redir(r));
                i = next;
            }
            _ => {
                let (word, next) = read_word(&src, i);
                if let Some(word) = word {
                    out.push(Tok::Word(word));
                }
                debug_assert!(next > i, "the lexer must always advance");
                i = next;
            }
        }
    }
    out
}

/// Read one redirection operator starting at `i`, returning it and the index after it.
fn read_redir(src: &[char], i: usize) -> (Redir, usize) {
    if src[i] == '<' {
        return match (src.get(i + 1), src.get(i + 2)) {
            (Some('<'), Some('<')) => (Redir::HereString, i + 3),
            // `<<-` strips leading tabs from the body; same operator for our purposes.
            (Some('<'), Some('-')) => (Redir::Heredoc, i + 3),
            (Some('<'), _) => (Redir::Heredoc, i + 2),
            (Some('&'), _) => (Redir::InDup, i + 2),
            (Some('>'), _) => (Redir::ReadWrite, i + 2),
            _ => (Redir::In, i + 1),
        };
    }
    match (src.get(i + 1), src.get(i + 2)) {
        (Some('>'), Some('&')) => (Redir::OutDup, i + 3),
        (Some('>'), _) => (Redir::OutAppend, i + 2),
        (Some('&'), _) => (Redir::OutDup, i + 2),
        // `>|` forces the write past `noclobber`; still a write.
        (Some('|'), _) => (Redir::Out, i + 2),
        _ => (Redir::Out, i + 1),
    }
}

/// Read one word starting at `i`.
///
/// Returns `None` for a bare file-descriptor prefix (`2` in `2>&1`): those digits belong to the
/// redirection operator that follows, not to the command.
fn read_word(src: &[char], start: usize) -> (Option<Word>, usize) {
    let mut i = start;
    let mut text = String::new();
    let mut expanded = false;
    let mut substitution = false;
    // An explicit `""` is an empty word that still counts; an empty word from anything else
    // (a lone line continuation) is not a word at all.
    let mut quoted = false;
    // Stays true only while every character so far is an unquoted ASCII digit.
    let mut all_digits = true;

    while i < src.len() {
        let c = src[i];
        match c {
            ' ' | '\t' | '\r' | '\n' | ';' | '&' | '|' | '(' | ')' => break,
            '<' | '>' => {
                if all_digits && !text.is_empty() {
                    return (None, i);
                }
                break;
            }
            '\\' => {
                all_digits = false;
                i += 1;
                match src.get(i) {
                    // A backslash-newline is a line continuation: it contributes nothing.
                    Some('\n') => i += 1,
                    Some(&n) => {
                        text.push(n);
                        i += 1;
                    }
                    None => {}
                }
            }
            '\'' => {
                all_digits = false;
                quoted = true;
                i += 1;
                while i < src.len() && src[i] != '\'' {
                    text.push(src[i]);
                    i += 1;
                }
                if i < src.len() {
                    i += 1;
                }
            }
            '"' => {
                all_digits = false;
                quoted = true;
                i += 1;
                while i < src.len() && src[i] != '"' {
                    if src[i] == '\\' {
                        // Inside double quotes a backslash only escapes these five.
                        match src.get(i + 1) {
                            Some(&n @ ('\\' | '"' | '$' | '`')) => {
                                text.push(n);
                                i += 2;
                            }
                            Some('\n') => i += 2,
                            _ => {
                                text.push('\\');
                                i += 1;
                            }
                        }
                        continue;
                    }
                    if src[i] == '$' && src.get(i + 1) == Some(&'(') {
                        let end = skip_balanced_parens(src, i + 1);
                        text.extend(&src[i..end]);
                        expanded = true;
                        substitution = true;
                        i = end;
                        continue;
                    }
                    if src[i] == '$' {
                        expanded = true;
                    }
                    if src[i] == '`' {
                        expanded = true;
                        substitution = true;
                    }
                    text.push(src[i]);
                    i += 1;
                }
                if i < src.len() {
                    i += 1;
                }
            }
            '$' => {
                all_digits = false;
                expanded = true;
                if src.get(i + 1) == Some(&'(') {
                    // `$(…)` and `$((…))` alike: swallowed whole so their `;` and `|` never split
                    // a segment. Nothing inside is classified — that is the published limit.
                    substitution = true;
                    let end = skip_balanced_parens(src, i + 1);
                    text.extend(&src[i..end]);
                    i = end;
                } else {
                    text.push('$');
                    i += 1;
                }
            }
            '`' => {
                all_digits = false;
                expanded = true;
                substitution = true;
                text.push('`');
                i += 1;
                while i < src.len() && src[i] != '`' {
                    text.push(src[i]);
                    i += 1;
                }
                if i < src.len() {
                    text.push('`');
                    i += 1;
                }
            }
            _ => {
                if !c.is_ascii_digit() {
                    all_digits = false;
                }
                text.push(c);
                i += 1;
            }
        }
    }

    // `""` is an empty argument and is kept; an empty word left behind by a line continuation
    // is not a word at all.
    if text.is_empty() && !quoted {
        return (None, i);
    }
    (
        Some(Word {
            text,
            expanded,
            substitution,
        }),
        i,
    )
}

/// Index just past the `)` that closes the `(` at `open`, or end of input.
fn skip_balanced_parens(src: &[char], open: usize) -> usize {
    let mut depth = 0usize;
    let mut i = open;
    while i < src.len() {
        match src[i] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    src.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &str) -> Vec<String> {
        lex(line)
            .into_iter()
            .filter_map(|t| match t {
                Tok::Word(w) => Some(w.text),
                _ => None,
            })
            .collect()
    }

    fn seps(line: &str) -> Vec<Sep> {
        lex(line)
            .into_iter()
            .filter_map(|t| match t {
                Tok::Sep(s) => Some(s),
                _ => None,
            })
            .collect()
    }

    fn redirs(line: &str) -> Vec<Redir> {
        lex(line)
            .into_iter()
            .filter_map(|t| match t {
                Tok::Redir(r) => Some(r),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn quoting_and_escapes_resolve_to_the_same_word() {
        for line in [r"cat x", r"\cat x", r#""cat" x"#, r"'cat' x", r#"c"a"t x"#] {
            assert_eq!(words(line), ["cat", "x"], "{line}");
        }
    }

    #[test]
    fn an_operator_inside_quotes_is_text_not_an_operator() {
        assert_eq!(words(r#"echo "a > b""#), ["echo", "a > b"]);
        assert!(redirs(r#"echo "a > b""#).is_empty());
        assert_eq!(words(r"echo 'a | b; c'"), ["echo", "a | b; c"]);
        assert!(seps(r"echo 'a | b; c'").is_empty());
        assert_eq!(words(r"echo a\>b"), ["echo", "a>b"]);
    }

    #[test]
    fn every_separator_is_recognised() {
        assert_eq!(seps("a; b"), [Sep::Semi]);
        assert_eq!(seps("a && b"), [Sep::AndAnd]);
        assert_eq!(seps("a || b"), [Sep::OrOr]);
        assert_eq!(seps("a | b"), [Sep::Pipe]);
        assert_eq!(seps("a |& b"), [Sep::Pipe]);
        assert_eq!(seps("a & b"), [Sep::Amp]);
        assert_eq!(seps("a\nb"), [Sep::Newline]);
        assert_eq!(seps("(a)"), [Sep::OpenGroup, Sep::CloseGroup]);
    }

    #[test]
    fn every_redirection_is_recognised_and_the_fd_prefix_is_dropped() {
        assert_eq!(redirs("a > f"), [Redir::Out]);
        assert_eq!(redirs("a >| f"), [Redir::Out]);
        assert_eq!(redirs("a >> f"), [Redir::OutAppend]);
        assert_eq!(redirs("a &> f"), [Redir::OutErr]);
        assert_eq!(redirs("a &>> f"), [Redir::OutErr]);
        assert_eq!(redirs("a < f"), [Redir::In]);
        assert_eq!(redirs("a <> f"), [Redir::ReadWrite]);
        assert_eq!(redirs("a <<EOF"), [Redir::Heredoc]);
        assert_eq!(redirs("a <<-EOF"), [Redir::Heredoc]);
        assert_eq!(redirs("a <<< s"), [Redir::HereString]);
        assert_eq!(redirs("a <&3"), [Redir::InDup]);
        // The `2` is the fd, not an argument.
        assert_eq!(redirs("a 2>&1"), [Redir::OutDup]);
        assert_eq!(words("a 2>&1"), ["a", "1"]);
        assert_eq!(words("a 2> err.log"), ["a", "err.log"]);
        assert_eq!(redirs("a 2> err.log"), [Redir::Out]);
    }

    #[test]
    fn a_command_substitution_is_swallowed_whole_and_flagged() {
        let toks = lex("echo $(cat secret; rm -rf /)");
        assert_eq!(seps("echo $(cat secret; rm -rf /)"), Vec::<Sep>::new());
        let Tok::Word(arg) = &toks[1] else {
            panic!("expected a word, got {:?}", toks[1])
        };
        assert_eq!(arg.text, "$(cat secret; rm -rf /)");
        assert!(arg.substitution && arg.expanded);
        // Arithmetic expansion nests parentheses; it must not end early.
        assert_eq!(words("echo $((1 + (2 * 3)))"), ["echo", "$((1 + (2 * 3)))"]);
        // Backticks, the older spelling.
        let toks = lex("echo `cat f`");
        let Tok::Word(arg) = &toks[1] else {
            panic!("expected a word")
        };
        assert!(arg.substitution);
    }

    #[test]
    fn a_plain_variable_is_left_unexpanded_but_flagged() {
        let toks = lex("$CMD arg");
        let Tok::Word(cmd) = &toks[0] else {
            panic!("expected a word")
        };
        assert_eq!(cmd.text, "$CMD");
        assert!(cmd.expanded);
        assert!(!cmd.substitution);
        // Single quotes kill the expansion entirely.
        let toks = lex("echo '$CMD'");
        let Tok::Word(arg) = &toks[1] else {
            panic!("expected a word")
        };
        assert!(!arg.expanded);
    }

    #[test]
    fn a_comment_ends_at_the_newline_and_a_hash_inside_a_word_does_not_start_one() {
        assert_eq!(words("ls # then cat f\npwd"), ["ls", "pwd"]);
        assert_eq!(words("grep a#b f"), ["grep", "a#b", "f"]);
    }

    #[test]
    fn a_line_continuation_joins_two_lines() {
        assert_eq!(words("cat \\\n  f"), ["cat", "f"]);
        assert_eq!(seps("cat \\\n  f"), Vec::<Sep>::new());
    }

    #[test]
    fn unterminated_quotes_do_not_lose_the_command() {
        assert_eq!(words("cat 'f"), ["cat", "f"]);
        assert_eq!(words("cat \"f"), ["cat", "f"]);
        assert_eq!(words("echo $(cat f"), ["echo", "$(cat f"]);
    }

    #[test]
    fn an_empty_line_yields_no_tokens() {
        assert!(lex("").is_empty());
        assert!(lex("   \t ").is_empty());
        assert!(lex("# nothing here").is_empty());
    }
}
