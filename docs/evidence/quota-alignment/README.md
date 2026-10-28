# Quota alignment correction — 2026-10-28

The previous fixture omitted Cloud Session Credits. Adding that wrapped label
reproduced the report: horizontal label/value offsets reached 42.05px, and values
in one row differed vertically by 15.59px.

Collapsed cells now stretch their children to a common left edge and reserve two
lines for labels. The updated browser assertion requires offsets and row spreads
below 1px. It passes wide, laptop, narrow, long-content and expanded states.
English limit labels and expand/collapse controls use title case within this
account section. The document title is Prox, with the old runtime override removed.

Screenshots use synthetic data. Full verification passes 1,946 tests, lint with
six existing warnings and no errors, TypeScript, and production builds. No quota
calculation, provider routing or refresh behavior changed.
