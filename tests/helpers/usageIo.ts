import { IoGovernor, type IoClock, type IoGovernorOptions } from '../../server/usage/ioGovernor';

export function fakeIo(options: Omit<IoGovernorOptions, 'clock'> = {}) {
  let time = 0;
  const sleeps: number[] = [];
  const clock: IoClock = {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
  const governor = new IoGovernor({
    readPsi: () => 'full avg10=0.00 avg60=0.00',
    ...options,
    clock,
  });
  return {
    governor,
    clock,
    sleeps,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
