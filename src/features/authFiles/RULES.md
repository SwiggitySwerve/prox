# Auth Files source ownership

The registry supplies every source panel, including external single-backend connections. Panels
remain visible concurrently; unavailable/authentication-required panels are not reported as empty.
Each panel keeps its existing layout, filtering, selections, models, editor drafts and quota cache.

`AuthFilesSourceProvider` owns a mounted view's immutable session and domain API factories.
The session delegates to its registry owner and rejects requests after the view disappears. Hooks
must use this context, check currentness after awaits, and use its labelled notification and
confirmation wrappers. A dialog must retain its original callback and owner; it cannot reacquire
whatever source is currently selected. Routed editors carry the source ID and captured owner.

`sourceScope.ts` delegates view lifetime to the shared `createSourceLease` transport guard.
It owns feature state, not domain normalization or quota rules. The Auth Files API
factory owns credential normalization and OAuth writes; the quota factory owns nested quota calls.
The scoped quota store reuses the existing store initializer and invalidation rules. Never merge
same-name files or quota entries across source panels. Bulk deletion uses the visible inventory
snapshot captured when confirmation opens, so newly discovered credentials do not join that action.

Inventory enumeration only reads inventory and routing metadata. Quota refresh/reset and credential
downloads require explicit actions; constructing a context or quota factory must not start them.
Feature tests use synthetic transports and contract checks. Browser interaction coverage is separate
from static/source tests. No real credentials or live quota requests belong in fixtures.
