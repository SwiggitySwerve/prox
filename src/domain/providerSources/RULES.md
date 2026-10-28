# Proxy instance sources

This domain owns instance descriptors, validation, alias resolution and discovery
projection. It does not own provider capabilities, credentials, quota arithmetic,
UI selection or resource-specific aggregation. Deployment input lives in
`deploy/provider-sources.json`; upstream origins and credential-file references
are private deployment inputs. Public discovery is an explicit allowlist.

- An instance ID identifies one logical proxy, regardless of its provider kinds.
  Never reuse an ID for a different logical backend. Labels are not identities.
- Canonical paths and aliases resolve to the same instance and enumerate once.
  Only exact configured connection membership enables deployment enumeration.
  An arbitrary external backend remains a single source.
- An auth scope is an explicit operator declaration that browser credentials may
  be shared across its configured same-origin routes, not a live-auth guarantee.
  Separate scopes require independent authentication. Never infer sharing from
  provider kind or origin alone. Current defaults preserve the checked-in shared
  credential-file routing; deployed compatibility still requires verification.
- Public discovery never includes upstream origins, credential references or
  backend response fields. A missing optional discovery document supports the
  portable single-backend application. Malformed/failed known discovery is an
  error, not a successful empty registry.
- Runtime source health is separate from configured membership. Unavailable
  instances remain represented; an error cannot authorize inventory retirement.
- Resource references retain the instance and the endpoint's existing local
  identifier. Transport sessions add monotonic epochs/generations; presentation
  filters cannot retarget an operation. Each feature owns its operation lifetime.

Source contract tests cover descriptor rejection, aliases, public projection and
external compatibility. Routing/session/consumer enforcement is implemented and
tested separately; this rules document alone is not an enforcement gate.
