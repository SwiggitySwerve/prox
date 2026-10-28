# Quota request ownership

Provider data modules own quota fetching and state construction. Numerical rules remain in their existing provider/domain helpers. Legacy configs and source configs run the same functions with different request dependencies.

- `createQuotaAdapters(session, store?)` captures an immutable source session. Constructing adapters performs no requests. Pass the source's `createQuotaStore()` instance to preserve file invalidation in nested Meta, Kimi and queued Devin reads.
- Every scoped request uses `session.management`, `createAuthFilesApi(session)` or `createApiCallApi(session)`. Dependencies are injected through `providers/dependencies.ts`; the default dependencies exist only for compatibility with `QUOTA_ADAPTERS`.
- Downloads, Blob text decoding, plugin discovery, optional subscription metadata, reset redemption, cooldown clearing and follow-up reads retain the captured source. Check currentness before dispatch and after asynchronous work. Optional-provider errors cannot convert a stale operation into a successful result at the adapter boundary.
- Each source section owns a separate quota store and plugin/Devin request cache. Owner keys include instance, session epoch and source generation. Never combine sources using a bare filename or auth index. The stores retain their existing local filename/index key semantics.
- Registry enumeration and header inventory refresh do not run quota providers, credential downloads, reset grants or inference. Quota refresh and xAI fallback remain explicit actions. Reset confirmation retains the session and cache generation captured when the confirmation opens.
- `QuotaCard` receives its scoped `adapter` prop. Its Claude reset hook receives `adapter.resetGrants`; the reset reader and ambiguous-operation journal are shared only within the captured session. Quota bodies perform no requests and need no ambient connection.
- Compatibility callers can omit dependencies. Source callers must not call the legacy configs, singleton reset journal or global quota store.

`tests/quotaSourceAdapters.test.ts` exercises synthetic A/B owners with overlapping identities, nested transport/key routing, stale actions and downloads, reset chains, metadata, passive enumeration and provider dependency imports. Existing provider tests protect numerical and legacy behavior. These tests do not establish live provider/plugin compatibility or browser interaction correctness.
