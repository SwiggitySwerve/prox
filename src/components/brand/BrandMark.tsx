import styles from './BrandMark.module.scss';

const UPPER = 'M7 16h6c4.5 0 4.5-7 10-7';
const LOWER = 'M13 16c4.5 0 4.5 7 10 7';
// Full entry-to-upstream routes the request packets travel, tinted for their upstream.
const ROUTES = [
  { upstream: 'claude', path: UPPER },
  { upstream: 'codex', path: 'M7 16h6c4.5 0 4.5 7 10 7' },
];

type BrandMarkProps = {
  className?: string;
  /** Draws the routes in, then keeps requests flowing to each upstream. */
  animated?: boolean;
};

// Routing mark: one entry point fanning out to the Claude and Codex upstreams.
export function BrandMark({ className, animated = false }: BrandMarkProps) {
  const classes = [styles.mark, animated ? styles.animated : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <svg viewBox="0 0 32 32" className={classes} aria-hidden="true" focusable="false">
      <path d={UPPER} pathLength={1} />
      <path d={LOWER} pathLength={1} />
      <circle className={styles.entry} cx="7" cy="16" r="2.8" />
      <circle className={styles.claude} cx="24" cy="9" r="3.2" />
      <circle className={styles.codex} cx="24" cy="23" r="3.2" />
      {animated &&
        ROUTES.map(({ upstream, path }, index) => {
          const begin = `${0.9 + index * 0.8}s`;
          return (
            <circle
              key={upstream}
              className={styles.packet}
              data-upstream={upstream}
              r="1.8"
              opacity="0"
            >
              <animateMotion path={path} dur="1.6s" begin={begin} repeatCount="indefinite" />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.1;0.9;1"
                dur="1.6s"
                begin={begin}
                repeatCount="indefinite"
              />
            </circle>
          );
        })}
    </svg>
  );
}
