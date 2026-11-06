import { useLayoutEffect, useState, type RefObject } from 'react';
import styles from './QuotaPoolPage.module.scss';

const PHONE = '(max-width: 640px)';

/** The element's width on one line, whatever room it has now, so the answer doesn't depend on the layout it picks. */
const naturalWidth = (element: HTMLElement) => {
  const before = element.style.whiteSpace;
  element.style.whiteSpace = 'nowrap';
  const range = document.createRange();
  range.selectNodeContents(element);
  const width = range.getBoundingClientRect().width;
  element.style.whiteSpace = before;
  return width;
};

/** Whether one card's mark, title, count and chip share a line at their natural widths. */
function fitsOneLine(title: HTMLElement) {
  const mark = title.firstElementChild;
  const heading = title.querySelector<HTMLElement>('h2');
  const count = title.querySelector<HTMLElement>(`.${styles.poolMeta} > :first-child`);
  const chip = title.querySelector<HTMLElement>(`.${styles.badge}`);
  const line = title.parentElement;
  if (!mark || !heading || !count || !chip || !line) return true;
  const gap = parseFloat(getComputedStyle(title).columnGap) || 0;
  // The chip's padding is outside its contents.
  const chipStyle = getComputedStyle(chip);
  const chipWidth =
    naturalWidth(chip) + parseFloat(chipStyle.paddingLeft) + parseFloat(chipStyle.paddingRight);
  const need =
    mark.getBoundingClientRect().width +
    naturalWidth(heading) +
    naturalWidth(count) +
    chipWidth +
    3 * gap;
  return need <= line.clientWidth;
}

/**
 * Phone provider cards keep each title, count and status chip on one line when every card's fits;
 * if any card's doesn't, every card's chip goes on its own second line, so one page never mixes the
 * two. CSS can't compare cards, so the page makes the choice and sets `data-chip-line` from it.
 */
export function usePhoneChipLine(root: RefObject<HTMLElement | null>) {
  const [secondLine, setSecondLine] = useState(false);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const decide = () => {
      const titles = [...node.querySelectorAll<HTMLElement>(`.${styles.poolTitle}`)];
      setSecondLine(
        window.matchMedia(PHONE).matches && titles.length > 0 && !titles.every(fitsOneLine)
      );
    };
    decide();
    const observer = new ResizeObserver(decide);
    observer.observe(node);
    void document.fonts?.ready.then(decide);
    return () => observer.disconnect();
  });
  return secondLine;
}
