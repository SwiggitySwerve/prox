# Account billing

This module owns provider billing parsing and billing fact decisions. Parsers accept provider JSON objects or serialized objects, ISO dates and epoch seconds/milliseconds; malformed input fails soft. Billing contains no credential or provider account identifier and remains in memory.

Codex renewal requires an explicit renewal decision; cancellation uses the end date. Payment delinquency is independent of renewal. Claude renewal is only an estimate for an active Stripe subscription, from its creation date's next UTC monthly anniversary, clamped to the target month's last day. It is not an annual-plan promise. Consumers translate the returned copy keys and format dates in the viewer's zone.

When structured Codex billing is absent, a valid subscriptions `active_until` or credential `id_token` subscription expiry may be shown only as an Estimated end date. Its basis names the source and says renewal is unconfirmed. Structured billing always takes precedence.
