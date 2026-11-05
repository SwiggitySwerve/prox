import { useEffect, type RefObject } from 'react';
import styles from './QuotaPoolPage.module.scss';

const ACCOUNT = '--compact-account-track';
const VALUE = '--compact-value-track';
// The grid's column-gap in the C block of the page styles.
const COLUMN_GAP = 16;

/**
 * Minimized account lists size their Account and value columns to their content (see the C block in
 * the page styles). Separate rows and cards can't share content-sized tracks in CSS, so this reads
 * each closed row's natural widths (the variables unset), takes the widest, and sets it once on the
 * container. Every closed row in every minimized card then uses the same columns.
 */
export function useSharedMinimizedTracks(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const width = (element: Element | null) => element?.getBoundingClientRect().width ?? 0;
    const measure = () => {
      frame = 0;
      root.style.removeProperty(ACCOUNT);
      root.style.removeProperty(VALUE);
      const cards = root.querySelectorAll('article[data-minimized="true"]');
      let account = 0;
      let value = 0;
      let other = 0;
      let row = 0;
      cards.forEach((card) => {
        card.querySelectorAll('details:not([open]) > summary').forEach((summary) => {
          row = width(summary);
          account = Math.max(account, width(summary.querySelector(`:scope > .${styles.accountName}`)));
          value = Math.max(value, width(summary.querySelector(':scope > strong')));
        });
        card.querySelectorAll(`.${styles.compactHead} > span:nth-child(2)`).forEach((head) => {
          value = Math.max(value, width(head));
        });
        card.querySelectorAll(`.${styles.compactHead} > span:nth-child(3)`).forEach((head) => {
          const text = document.createRange();
          text.selectNodeContents(head);
          other = Math.max(other, text.getBoundingClientRect().width);
        });
      });
      // A narrow card leaves the Other low limits heading its width first: the Account column
      // gives up the difference, and a long name ends in an ellipsis.
      if (row > 0) account = Math.min(account, row - value - other - 2 * COLUMN_GAP);
      if (account > 0) root.style.setProperty(ACCOUNT, `${Math.ceil(account)}px`);
      if (value > 0) root.style.setProperty(VALUE, `${Math.ceil(value)}px`);
      // A name that ends in an ellipsis says its whole text in a title; any other name has none.
      root.querySelectorAll<HTMLElement>(`.${styles.accountText}`).forEach((name) => {
        if (name.scrollWidth > name.clientWidth + 1) name.title = name.textContent ?? '';
        else name.removeAttribute('title');
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // A mutation is measured in its own microtask, before paint, so no row shows at the old columns.
    const observer = new MutationObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      measure();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-minimized'],
    });
    window.addEventListener('resize', schedule);
    void document.fonts?.ready.then(schedule);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
