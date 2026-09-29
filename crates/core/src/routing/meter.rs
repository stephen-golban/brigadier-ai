//! Turns a CLI session's running token totals into what each turn used.

use std::sync::{Mutex, PoisonError};

use brigadier_providers::TokenUsage;

/// Both CLIs report a session's totals so far (`ProviderEvent::Usage`); the difference from
/// the previous report is what the turn in between used. A total below the last one means the
/// CLI started counting afresh (a new process for the same session), so it counts whole.
#[derive(Debug, Default)]
pub struct TokenMeter {
    last: Mutex<Baseline>,
}

#[derive(Debug, Default)]
enum Baseline {
    /// Nothing reported yet: the first report is all this session used.
    #[default]
    Fresh,
    /// Nothing reported yet, and the first report includes turns counted before.
    Continued,
    Seen(TokenUsage),
}

impl TokenMeter {
    /// A meter for a CLI session. `continues` says the CLI resumes a session whose earlier
    /// turns it already counted (a Codex thread's totals span its whole life): its first
    /// report only sets the baseline.
    pub fn new(continues: bool) -> Self {
        Self {
            last: Mutex::new(if continues {
                Baseline::Continued
            } else {
                Baseline::Fresh
            }),
        }
    }

    /// What was used since the last report, if anything.
    pub fn delta(&self, total: &TokenUsage) -> Option<TokenUsage> {
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        let previous = std::mem::replace(&mut *last, Baseline::Seen(total.clone()));
        let delta = match previous {
            Baseline::Continued => return None,
            Baseline::Seen(previous) if sum(total) >= sum(&previous) => TokenUsage {
                input_tokens: (total.input_tokens - previous.input_tokens).max(0),
                cached_input_tokens: (total.cached_input_tokens - previous.cached_input_tokens)
                    .max(0),
                cache_write_tokens: (total.cache_write_tokens - previous.cache_write_tokens).max(0),
                output_tokens: (total.output_tokens - previous.output_tokens).max(0),
                reasoning_tokens: (total.reasoning_tokens - previous.reasoning_tokens).max(0),
                cost_usd: None,
            },
            Baseline::Fresh | Baseline::Seen(_) => total.clone(),
        };
        (sum(&delta) > 0).then_some(delta)
    }
}

fn sum(usage: &TokenUsage) -> i64 {
    usage.input_tokens + usage.cached_input_tokens + usage.cache_write_tokens + usage.output_tokens
}
