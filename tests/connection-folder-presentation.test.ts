import { test } from "node:test";
import assert from "node:assert/strict";
import { collapsedGroups, revealConnectionFolder, remapCollapsedFolders } from "../src/app/connection-groups.ts";

test("moving a connection reveals its folder and every collapsed ancestor", () => {
  collapsedGroups.clear();
  for (const key of ["folder:work", "folder:work/production", "folder:other", "ungrouped"]) collapsedGroups.add(key);
  revealConnectionFolder("Work/Production");
  assert.deepEqual([...collapsedGroups].sort(), ["folder:other", "ungrouped"]);
  revealConnectionFolder("");
  assert.deepEqual([...collapsedGroups], ["folder:other"]);
});

test("renaming preserves subtree collapse state and deleting clears only that subtree", () => {
  collapsedGroups.clear();
  for (const key of ["folder:work", "folder:work/production", "folder:workload", "ungrouped"]) collapsedGroups.add(key);
  remapCollapsedFolders("Work", "Company");
  assert.deepEqual([...collapsedGroups].sort(), ["folder:company", "folder:company/production", "folder:workload", "ungrouped"]);
  remapCollapsedFolders("Company", null);
  assert.deepEqual([...collapsedGroups].sort(), ["folder:workload", "ungrouped"]);
  remapCollapsedFolders("", "Home");
  assert.ok(collapsedGroups.has("ungrouped"));
});
