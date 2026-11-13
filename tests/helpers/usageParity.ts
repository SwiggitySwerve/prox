import { QueryGate } from '../../scripts/usage-parity/io';

export function quietGate(signal = new AbortController().signal) {
  let now = 0;
  return new QueryGate(
    signal,
    0,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    () => 'some avg10=0.00\nfull avg10=0.00 avg60=0.00'
  );
}
