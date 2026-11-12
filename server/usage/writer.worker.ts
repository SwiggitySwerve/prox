// Worker entry stays separately bundled; all SQLite and bulk state belong to this thread.
import { startUsageWriterWorker } from './writerRuntime';

startUsageWriterWorker();
