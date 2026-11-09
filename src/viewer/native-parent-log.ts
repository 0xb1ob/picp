/** Where the native parent's pi-format log sits; the viewer owns the path, the native entry writes it. */
import { basename, dirname, join } from "node:path";

/** The native parent's log for its record `<sessions>/<name>.jsonl`: `<sessions>/native-parent-log/<name>.jsonl`. */
export const nativeParentLogFile = (record: string): string => join(dirname(record), "native-parent-log", basename(record));
