import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { selectRuntimeMount } from "../../tools/secure-release/server-worker.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/route-validation/secure-release/mount-views.json", import.meta.url)));

it("selects the kernel-visible mount even when matching readonly bindings are duplicated", () => {
  for (const filesystems of [fixture.filesystems, [...fixture.filesystems].reverse()]) {
    const selected = selectRuntimeMount(filesystems, fixture.runtime, fixture.visibleMountId);
    assert.equal(selected.id, 1367);
    assert.ok(selected.options.split(",").includes("ro"));
  }
  assert.equal(selectRuntimeMount(fixture.filesystems, fixture.runtime, 1333).id, 1333);
});

it("does not let a valid hidden mount authorize a different visible filesystem", () => {
  for (const changes of [{ source: "foreign-source" }, { fstype: "ext4" }]) {
    const filesystems = structuredClone(fixture.filesystems);
    Object.assign(filesystems[1], changes);
    assert.throws(() => selectRuntimeMount(filesystems, fixture.runtime, 1367), /not owned/);
  }
});

it("fails closed when the directory mount ID is missing, invalid, ambiguous or at another path", () => {
  for (const id of [NaN, 0, -1, 9876]) assert.throws(() => selectRuntimeMount(fixture.filesystems, fixture.runtime, id), /visible runtime/);
  assert.throws(() => selectRuntimeMount([...fixture.filesystems, fixture.filesystems[1]], fixture.runtime, 1367), /visible runtime/);
  const filesystems = structuredClone(fixture.filesystems);
  filesystems[1].target = "/run/another-engine";
  assert.throws(() => selectRuntimeMount(filesystems, fixture.runtime, 1367), /visible runtime/);
});
