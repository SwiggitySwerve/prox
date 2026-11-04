# Loading

Closes: loading skeleton mismatch (214 notes, every round), loading status placement.

## Rules

- **Non-data UI renders immediately** [R§5]: page header, view bar, card titles and provider marks, section headings, the accounts toolbar. Controls are never skeletons [R§5: Carbon], except that on phones (≤ 640px) the loading page may draw control placeholders (utility row, tabs, date, Options, the Combined graph toggle and chart-view select, each provider card's count, chip and action pills) when they match the loaded geometry: row tops and the first card top stay within 4px of the loaded page's. Placeholders are inert and aria-hidden. Pool chips render with their count slot reserved (min-width), showing "–" until known.
- **Skeletons come from the real components.** `PoolCard` renders with a loading view model and each slot draws its own placeholder at its real size: headline bar 40px tall, two label bars, the meter, the four fact slots (label + value bars, three-line height), the plot area at its tier height, and three table rows under a real header. When the real layout changes, the skeleton changes with it; on phones the identity row (title, count, chip) and the pill row mirror the loaded card header.
- **One indicator** [R§5]: RefreshControl reads "Loading…"; one polite announcement for the whole group ("Loading quota", then "Quota loaded"). No spinner inside cards.
- Skeleton surface `--skeleton-bg` (distinct from control fill) with a slow shimmer; under reduced motion, a gentle opacity pulse.
- Timing: nothing for loads under 1s; skeletons from 1s [R§5].
- **Refresh keeps data on screen**; only RefreshControl shows busy [R§5].
- Check: within the first viewport, no region's top edge moves more than 4px between the skeleton and the first data frame.
