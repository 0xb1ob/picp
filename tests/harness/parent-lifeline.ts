/** `--import` preload: the child exits when its stdin pipe closes, so a SIGKILLed test runner leaks no viewer. */
if (process.env.CP_TEST_LIFELINE) {
	// Only this process: grandchildren inherit NODE_OPTIONS, often with stdin ignored.
	delete process.env.CP_TEST_LIFELINE;
	process.stdin.once("end", () => process.exit(0)).resume();
}
