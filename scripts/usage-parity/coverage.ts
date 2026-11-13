// Plan §2.7's narrow, independently specified coverage compatibility rule.
import type { AnalyticsResponse } from '../../src/domain/analytics/types';
import type { Difference } from './compare';

export const SUCCESSIVE_READS =
  'Views use successive reads; concurrent ingestion can change counts between views or pages.';
const CONDITION_SENTENCES = new Set([
  'records in flight during a collector or proxy restart may be absent',
  'History in this range was imported from CPAMP.',
  'The rate book failed to load; the last good book is used when available.',
  'Records from an unknown provider are stored as reported; normalization is limited.',
]);
function conditionSentence(sentence: string, response: AnalyticsResponse): boolean {
  if (CONDITION_SENTENCES.has(sentence)) return true;
  const gap = /^Known collection gap for (.+): \[(\d+), (\d+)\)\.$/.exec(sentence);
  if (gap) {
    const from = Number(gap[2]),
      to = Number(gap[3]);
    return (
      !response.coverage.raw_complete &&
      Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      from < to &&
      from < response.to_ms &&
      to > response.from_ms
    );
  }
  const pruned = /^History before retention_floor_ms (\d+) has been pruned\.$/.exec(sentence);
  return (
    !!pruned &&
    !response.coverage.raw_complete &&
    Number.isSafeInteger(Number(pruned[1])) &&
    Number(pruned[1]) > response.from_ms
  );
}
export function coverageDifference(
  cpamp: AnalyticsResponse,
  prox: AnalyticsResponse
): Difference | undefined {
  const before = cpamp.coverage.limitations,
    after = prox.coverage.limitations;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  let valid =
    Array.isArray(before) &&
    Array.isArray(after) &&
    [...before, ...after].every((value) => typeof value === 'string') &&
    new Set(after).size === after.length;
  if (valid) {
    const remaining = [...after];
    for (const sentence of before) {
      const index = remaining.indexOf(sentence);
      if (index >= 0) remaining.splice(index, 1);
      else if (sentence !== SUCCESSIVE_READS) valid = false;
    }
    // A duplicate fixed sentence is not an allowed extra. Match occurrences, not just sets.
    if (!remaining.every((sentence) => conditionSentence(sentence, prox))) valid = false;
  }
  return {
    class: valid ? 'coverage-limitations' : 'unexplained',
    path: '$.coverage.limitations',
    cpamp: before,
    prox: after,
  };
}
