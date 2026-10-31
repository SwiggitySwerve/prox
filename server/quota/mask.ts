/**
 * A recognisable but non-identifying form of an account's address or file name, e.g.
 * `ada.lovelace@example.test` becomes `ada•••ce@ex•••.test`. It is sent with every dashboard so
 * accounts can be told apart; the full address still needs the explicit reveal.
 */
const DOTS = '•••';

/** Keep `head` leading and `tail` trailing characters; short values keep only their first one. */
const maskPart = (value: string, head: number, tail: number) =>
  value.length <= head + tail + 2
    ? `${value.slice(0, 1)}${DOTS}`
    : `${value.slice(0, head)}${DOTS}${tail ? value.slice(-tail) : ''}`;

export function maskIdentifier(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return maskPart(value, 3, 2);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const maskedDomain =
    dot > 0
      ? `${maskPart(domain.slice(0, dot), 2, 0)}${domain.slice(dot)}`
      : maskPart(domain, 2, 0);
  return `${maskPart(value.slice(0, at), 3, 2)}@${maskedDomain}`;
}
