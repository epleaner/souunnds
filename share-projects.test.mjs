import { expect, it } from "vitest";
import { MemoryProjectStore, ProjectService } from "./src/server/share-projects.mjs";

function manifest(name = "First") {
  return { version: 1, sources: [{ id: "source-1", name, duration: 2.5, kind: "missing" }],
    state: { layers: [{ id: "layer-1", sourceId: "source-1" }], sequencers: [], effects: {} } };
}

it("publishes a read-only project without leaking the creator capability", async () => {
  const projects = new ProjectService(new MemoryProjectStore());
  const { project, capability } = await projects.create(manifest());
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(project.revision).toBe(1);
  expect(await projects.read(project.id)).toEqual(project);
  expect(JSON.stringify(await projects.read(project.id))).not.toContain(capability);
});

it("rejects nonowners and stale or simultaneous writes while preserving the winner", async () => {
  const projects = new ProjectService(new MemoryProjectStore());
  const { project, capability } = await projects.create(manifest());
  await expect(projects.update(project.id, "A".repeat(43), 1, manifest("Intruder")))
    .rejects.toMatchObject({ status: 403 });
  await expect(projects.update(project.id, "", 1, manifest("Intruder")))
    .rejects.toMatchObject({ status: 401 });
  await projects.update(project.id, capability, 1, manifest("Saved"));
  await expect(projects.update(project.id, capability, 1, manifest("Stale")))
    .rejects.toMatchObject({ status: 409 });
  const outcomes = await Promise.allSettled([
    projects.update(project.id, capability, 2, manifest("Concurrent A")),
    projects.update(project.id, capability, 2, manifest("Concurrent B")),
  ]);
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
  const saved = await projects.read(project.id);
  expect(saved.revision).toBe(3);
  expect(["Concurrent A", "Concurrent B"]).toContain(saved.manifest.sources[0].name);
});

it("rejects unsafe manifests and allows only the owner to delete", async () => {
  const projects = new ProjectService(new MemoryProjectStore());
  await expect(projects.create({ version: 99 })).rejects.toMatchObject({ status: 400 });
  const unsafe = manifest();
  unsafe.sources[0] = { ...unsafe.sources[0], kind: "youtube", url: "https://evil.example/watch?v=abcdefghijk" };
  await expect(projects.create(unsafe)).rejects.toMatchObject({ status: 400 });
  const { project, capability } = await projects.create(manifest());
  await expect(projects.delete(project.id, "")).rejects.toMatchObject({ status: 401 });
  await projects.delete(project.id, capability);
  await expect(projects.read(project.id)).rejects.toMatchObject({ status: 404 });
});
