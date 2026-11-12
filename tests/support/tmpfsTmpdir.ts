import { accessSync, constants } from 'node:fs';

// Tests build real SQLite files (WAL, fsync per commit) under os.tmpdir(). On a disk that other
// jobs keep busy, every fsync waits on the shared filesystem journal, so a store test that takes
// milliseconds on a quiet machine can take minutes and trips bun's 5s per-test timeout. Nothing
// here needs durability, so keep the scratch files on tmpfs when the host has one.
// bunfig.toml loads this preload only for `bun test` run from the repo root (bun does not read it
// from a subdirectory), and an explicitly set TMPDIR wins over the tmpfs default.
if (!process.env.TMPDIR) {
  try {
    accessSync('/dev/shm', constants.W_OK);
    process.env.TMPDIR = '/dev/shm';
  } catch {
    // No writable tmpfs (macOS, locked-down containers): keep the platform default.
  }
}
