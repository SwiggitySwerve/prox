# Plugin source ownership

- Installed inventory enumerates `useProviderSources`; each source has its own session-keyed UI state, errors and actions. Equal local plugin IDs on different instances are separate resources.
- Store installs require an explicit deployment destination (`?source=instanceId`). The external single-backend path may use its sole resolved source. An invalid explicit source never falls back.
- Plugin APIs, config read-modify-write, runtime/store polling and release API-call requests capture one `SourceSession`. They check currentness before dispatch and after completion. The singleton exports remain compatibility entry points; scoped callers use the factories.
- `pluginsApi.list(transport)` remains supported for quota consumers. Malformed inventories reject instead of becoming complete-empty.
- Capability metadata starts unknown/false. A passive config read may populate response-header metadata; its body is discarded. Enumeration does not invoke quota probes, inference or plugin actions.
- `loadPluginSourceInventories(sources, readSources)` retains complete, unsupported, unavailable and stale outcomes per source. Unavailable outcomes distinguish authentication, malformed inventory and request failure without exposing raw responses. Callers must guard their own refresh lifetime before publishing results and must not erase healthy results because another source failed.
- Resource links include source identity. Deployment embedding remains explicitly unsupported because initial URLs do not prove ownership of nested requests. Never inject management credentials into resource URLs or iframes. External resource behavior is preserved.
- Store registry `sourceId` and owning backend `instanceId` are different identities. Preserve both during install and polling. Preserve the existing official-source/repository trust rules and third-party confirmation steps.
- Confirmation closures capture the source that opened them. Mounted views use the shared `useSourceLease`/`createSourceLease` lifetime guard. Destination/session changes remount drafts, dialogs and release caches; they do not retarget pending operations.

Synthetic boundary coverage lives in `tests/pluginSourceOwnership.test.ts`. It proves API ownership and partial outcomes, not live deployments, iframe behavior or browser interactions. The route table, layout aggregation and locale registration are owned outside this feature.
