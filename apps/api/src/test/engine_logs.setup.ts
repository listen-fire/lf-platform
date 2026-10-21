// Tests are quiet by default: the engine's log lines go nowhere unless a test
// captures them (`captureEngineLogs` in ./engine_logs).
import { silenceEngineLogs } from './engine_logs';

silenceEngineLogs();
