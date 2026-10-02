/**
 * Guard fixture (um58 #17): a file whose only top-level item is a todo suite
 * with a reason and no children, so the suite's own completion (`todo: "later"`)
 * is the only evidence the file did anything.
 */
import { describe } from "node:test";

describe("todo suite with a reason and no children", { todo: "later" }, () => {});
