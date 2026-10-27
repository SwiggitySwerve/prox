# Provider quota windows

This package owns Claude and Codex payload-to-window conversion for both the
existing credential UI and the Prox history collector. Provider data modules
re-export the builders for existing callers. Keep IDs, reset parsing, periods,
fallbacks, labels, and missing values consistent here; do not add a second raw
payload parser in the history service or dashboard.
