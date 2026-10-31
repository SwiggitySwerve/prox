# Loading

Closes: loading skeleton mismatch (214 notes, every round), loading status placement.

## Rules

- **Non-data UI renders immediately** [R§5]: page header, view bar, card titles and provider marks, section headings, the accounts toolbar. Controls are never skeletons [R§5: Carbon]. Pool chips render with their count slot reserved (min-width), showing "–" until known.
- **Skeletons come from the real components.** `PoolCard` renders with a loading view model and each slot draws its own placeholder at its real size: headline bar 40px tall, two label bars, the meter, the four fact slots (label + value bars, three-line height), the plot area at its tier height, and three table rows under a real header. When the real layout changes, the skeleton changes with it.
- **One indicator** [R§5]: RefreshControl reads "Loading…"; one polite announcement for the whole group ("Loading quota", then "Quota loaded"). No spinner inside cards.
- Skeleton surface `--skeleton-bg` (distinct from control fill) with a slow shimmer; under reduced motion, a gentle opacity pulse.
- Timing: nothing for loads under 1s; skeletons from 1s [R§5].
- **Refresh keeps data on screen**; only RefreshControl shows busy [R§5].
- Check: within the first viewport, no region's top edge moves more than 4px between the skeleton and the first data frame.
