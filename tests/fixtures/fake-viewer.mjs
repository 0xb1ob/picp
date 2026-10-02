/**
 * Stand-in for `cp-view`: listens on 127.0.0.1:<argv[2]> and, when
 * FAKE_VIEWER_PIDFILE is set, writes its pid there once listening.
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

createServer((_req, res) => res.end("fake viewer")).listen(Number(process.argv[2]), "127.0.0.1", () => {
	if (process.env.FAKE_VIEWER_PIDFILE) writeFileSync(process.env.FAKE_VIEWER_PIDFILE, String(process.pid));
});
