import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isWithinAllowedRoots } from "../src/projects/context.js";

test("isWithinAllowedRoots allows a path inside an allowed root", () => {
  const root = path.resolve("/home/user/projects");
  assert.equal(isWithinAllowedRoots(path.join(root, "propertyscribe"), [root]), true);
});

test("isWithinAllowedRoots allows the root itself", () => {
  const root = path.resolve("/home/user/projects");
  assert.equal(isWithinAllowedRoots(root, [root]), true);
});

test("isWithinAllowedRoots rejects a sibling directory that shares a prefix", () => {
  const root = path.resolve("/home/user/projects");
  const sibling = path.resolve("/home/user/projects-evil");
  assert.equal(isWithinAllowedRoots(sibling, [root]), false);
});

test("isWithinAllowedRoots rejects a path traversal attempt", () => {
  const root = path.resolve("/home/user/projects/app");
  const traversal = path.resolve(root, "../../etc/passwd");
  assert.equal(isWithinAllowedRoots(traversal, [root]), false);
});

test("isWithinAllowedRoots returns false when no roots are configured", () => {
  assert.equal(isWithinAllowedRoots("/anywhere", []), false);
});

test("isWithinAllowedRoots checks against every configured root", () => {
  const rootA = path.resolve("/home/user/work-a");
  const rootB = path.resolve("/home/user/work-b");
  assert.equal(isWithinAllowedRoots(path.join(rootB, "project"), [rootA, rootB]), true);
});
