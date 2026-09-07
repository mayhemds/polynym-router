import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseFileBlocks, resolveSafeFilePath, FileChangeError } from "../src/agent/parseFileBlocks.js";

test("parseFileBlocks extracts a single file block", () => {
  const text = 'Here is the change:\n\nFILE: src/app.py\n```python\nprint("hi")\n```\n';
  const result = parseFileBlocks(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].relativePath, "src/app.py");
  assert.equal(result[0].content.trim(), 'print("hi")');
});

test("parseFileBlocks extracts multiple file blocks in one response", () => {
  const text = [
    "FILE: a.py",
    "```",
    "content a",
    "```",
    "",
    "FILE: b.py",
    "```",
    "content b",
    "```",
  ].join("\n");
  const result = parseFileBlocks(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].relativePath, "a.py");
  assert.equal(result[1].relativePath, "b.py");
});

test("parseFileBlocks returns an empty array when the model ignores the format", () => {
  const result = parseFileBlocks("Sure, I would change the auth module to use bcrypt.");
  assert.deepEqual(result, []);
});

test("parseFileBlocks ignores prose surrounding the blocks", () => {
  const text = 'I will add retry logic.\n\nFILE: retry.py\n```python\ndef retry(): pass\n```\n\nThat should do it.';
  const result = parseFileBlocks(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].relativePath, "retry.py");
});

test("resolveSafeFilePath allows a normal nested relative path", () => {
  const root = path.resolve("/tmp/project");
  const resolved = resolveSafeFilePath(root, "src/utils/helpers.py");
  assert.equal(resolved, path.join(root, "src", "utils", "helpers.py"));
});

test("resolveSafeFilePath rejects an absolute path", () => {
  const root = path.resolve("/tmp/project");
  assert.throws(() => resolveSafeFilePath(root, "/etc/passwd"), FileChangeError);
});

test("resolveSafeFilePath rejects a traversal attempt", () => {
  const root = path.resolve("/tmp/project");
  assert.throws(() => resolveSafeFilePath(root, "../../etc/passwd"), FileChangeError);
});

test("resolveSafeFilePath rejects writes into .git", () => {
  const root = path.resolve("/tmp/project");
  assert.throws(() => resolveSafeFilePath(root, ".git/hooks/pre-commit"), FileChangeError);
});

test("resolveSafeFilePath rejects a traversal attempt hidden in the middle of the path", () => {
  const root = path.resolve("/tmp/project");
  assert.throws(() => resolveSafeFilePath(root, "src/../../outside.py"), FileChangeError);
});
