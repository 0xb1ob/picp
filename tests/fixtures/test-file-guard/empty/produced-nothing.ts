/**
 * Guard fixture (um58 #17): a discovered test file that registers nothing.
 * The runner reports its file root as passing, so only the guard can notice it,
 * and the guard must fail the run naming this file.
 */
export const nothing = true;
