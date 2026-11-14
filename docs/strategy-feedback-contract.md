# Strategy feedback contract v1

This is an offline, account-free interchange contract. It does not create prospective evidence, certify a fill, validate a release or snapshot, authorize a strategy, or connect the existing journal, evaluation, execution, or scheduling paths. Fixture events and their `ACTUAL_FILL` value are synthetic test vectors only. Existing `researchJournal` records retain their own immutable, account-scoped identity; `researchRecord` plans are not fills; research evaluations are separate. TactiCore's candidate shadow records retain their existing provenance and temporal-seal rules.

## Event

All objects use exactly the fields below; unknown fields are rejected. Identifiers and reason codes are ASCII `[A-Za-z][A-Za-z0-9_.-]{0,63}`. They must be non-sensitive public or synthetic labels; never encode account, client, broker, order, position, cash, credential, trade details, or identifying information in any field. This is a producer obligation: syntax validation cannot detect sensitive information hidden in an otherwise valid identifier. No free text or raw evidence enters the contract.

- `schema_version`: `strategy-feedback-1`; `event_id`: unique opaque identifier.
- `event_type`: one of the four types below.
- `release_hash`, `snapshot_hash`: lowercase SHA-256 (64 hex characters), referencing the frozen release content and input snapshot respectively. Their existence and integrity must be verified by the producer/consumer independently.
- `occurred_at`, `recorded_at`: UTC `YYYY-MM-DDTHH:mm:ssZ`; occurrence must not be later than recording. These are assertions, not proof of real-time creation or prospective eligibility.
- `coverage`: exactly `universe_id`, `period_start`, `period_end`; dates are valid `YYYY-MM-DD` with start <= end. The universe identifier must refer to a separately defined research scope, not an account or holdings list.
- `payload`: exactly the keys for the event type:
  - `SIGNAL_EVALUATED`: `signal_id`, `result` (`TRIGGERED`, `NOT_TRIGGERED`, `UNAVAILABLE`).
  - `DECISION`: `signal_event_id`, `result` (`ACCEPTED`, `REJECTED`, `NO_ACTION`), `reason_code`.
  - `OUTCOME`: `decision_event_id`, `result` (`PENDING`, `UNAVAILABLE`, `OBSERVED`, `ACTUAL_FILL`), `reason_code`. Observation is not execution. Actual fill is only a classification asserted by an authoritative external source, and carries no execution or account details.
  - `CORRECTION`: `corrects_event_id`, `reason_code`. A correction is a new immutable event and must not point to itself; it flags the referenced event without modifying it. Corrected facts, if needed, are separate new events.

References are identifiers only: v1 does not check existence, linkage, temporal order, release/snapshot equivalence across events, or authority of outcomes. Consumers must perform those checks before using events as evidence. In particular, real prospective evidence remains subject to the existing candidate-specific provenance and seal rules.

## Content identity and append

Content identity is SHA-256 of the UTF-8 encoding of compact JSON with object keys sorted in ASCII order. The v1 schema uses only ASCII strings and objects, avoiding cross-language number and Unicode normalization ambiguity. Every event field, including event ID and both times, participates. The fixed synthetic fixtures contain expected hashes and cover untriggered, rejected, no-action, all outcome categories, and correction.

`appendEvent` / `append_event` validate the input and existing sequence and return a detached new sequence. Repeating an ID with identical content is idempotent; the same ID with different content raises an error. Originals are never modified. This helper is in-memory only; any future durable implementation must atomically enforce uniqueness and immutability across processes and protect its own storage. It does not repair an already corrupt sequence.

To run the direct cross-language comparison, build FinanceMCP and set `TACTICORE_FEEDBACK_ROOT` to the TactiCore checkout root when running `node --test test/strategy-feedback.test.mjs`. Both repos also independently test the same fixed synthetic hashes. The matching fixture files are duplicated deliberately for standalone tests and must remain byte-identical.
