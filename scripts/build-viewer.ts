import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeHome } from "../src/home.ts";
import { resolveStateDir } from "../src/viewer/sessions.ts";
import { buildViewer } from "../src/viewer/build.ts";
const {values} = parseArgs({options:{home:{type:"string"}}});
const home = resolve(values.home ?? describeHome().home);
try {
 const app = await buildViewer({stateDir:resolveStateDir(home)});
 process.stdout.write(`viewer: ${Object.keys(app.assets).length} assets, ${app.bytes} bytes in ${app.duration_ms}ms\n`);
} catch (error) {
 process.stderr.write(`viewer build failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
 process.exitCode = 1;
}
