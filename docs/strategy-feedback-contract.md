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

References are identifiers only: the v1 shape validator does not check existence, linkage, temporal order, release/snapshot equivalence across events, or authority of outcomes. The local durable importer checks linkage, ordering and coverage consistency; it does not prove the authority of outcomes or the integrity of external releases and snapshots. Real prospective evidence remains subject to the existing candidate-specific provenance and seal rules.

## Content identity and append

Content identity is SHA-256 of the UTF-8 encoding of compact JSON with object keys sorted in ASCII order. The v1 schema uses only ASCII strings and objects, avoiding cross-language number and Unicode normalization ambiguity. Every event field, including event ID and both times, participates. The fixed synthetic fixtures contain expected hashes and cover untriggered, rejected, no-action, all outcome categories, and correction.

`appendEvent` / `append_event` validate the input and existing sequence and return a detached new sequence. Repeating an ID with identical content is idempotent; the same ID with different content raises an error. Originals are never modified. The local SQLite importer additionally performs an atomic batch append with reference and consistency checks. Its trust boundary is the local user and filesystem permissions, not cryptographic authentication or protection against a user who can rewrite the database.

To run the direct cross-language comparison, build FinanceMCP and set `TACTICORE_FEEDBACK_ROOT` to the TactiCore checkout root when running `node --test test/strategy-feedback.test.mjs`. Both repos also independently test the same fixed synthetic hashes. The matching fixture files are duplicated deliberately for standalone tests and must remain byte-identical.

## Local store

`finance-ashare portfolio-strategy-feedback import --file events.jsonl --confirm` appends one JSON event per line in a single transaction. `finance-ashare portfolio-strategy-feedback list` lists the validated log in append order. `--db PATH` overrides `ASHARE_STRATEGY_FEEDBACK_DB`, which overrides `~/.local/share/ashare-private/strategy-feedback.sqlite`. The private directory and database are restricted to the owning user. Identical IDs and content are idempotent; conflicting IDs or a broken reference reject the whole batch. Corrections are appended and do not erase prior events.

## Real journal boundary

The real journal reader verifies its stored content hash and mirrored row fields, and journal CLI resolves an account before listing; journal records contain private account identifiers, observations, arbitrary evidence and payload. They do not, by themselves, establish a contract release hash, complete input snapshot hash, public universe, signal/decision event chain, or authoritative fill. An optional hotspot binding identifies a particular hotspot snapshot, not necessarily the complete strategy input. These missing facts must remain unavailable, not be derived from account snapshots, dates, versions or current pointers. Real adaptation requires separately verified mappings and authorization, privacy review of every exported identifier and reason, release/snapshot integrity and linkage, and durable storage protection. The feedback importer reads only the explicitly supplied JSONL file; it does not read or copy real journal or account data. The producer remains responsible for ensuring the file contains only non-sensitive public or synthetic labels.
