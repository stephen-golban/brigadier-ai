// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 65, in one import.
 *
 * `Sink` is the only writer. `SecretInventory` is the one inventory, append-only
 * by construction. `audit.ts` is the gate that keeps the first sentence true —
 * it is not re-exported here, because it is a test's dependency rather than a
 * module the product calls, and an export nobody uses is an invitation.
 *
 * THE HONEST LIMIT travels with the import, because it must be stated wherever
 * this is described: **redaction defeats VERBATIM leaks only.** A worker that
 * paraphrases a key, re-encodes it in a scheme `encodedForms` does not
 * enumerate, splits it across prose, or describes it is caught by neither the
 * sink nor the product.
 */

export {
  MINIMUM_SECRET_LENGTH,
  PLACEHOLDER,
  SecretInventory,
  encodedForms,
  encodings,
  type EncodedForm,
  type EncodingName,
} from "./redact.ts";
export { Sink, SinkMisuse, type Grant, type SinkStreams } from "./sink.ts";
