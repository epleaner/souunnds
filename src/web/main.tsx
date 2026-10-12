import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./themed-select.css";

const root = createRoot(document.getElementById("root")!);

async function start() {
  const projectMatch = /^\/p\/([A-Za-z0-9_-]{20,64})\/?$/.exec(window.location.pathname);
  if (!projectMatch) {
    try {
      window.sessionStorage.removeItem("souunnds.open-project");
    } catch {
      // Keep the local studio available when session storage is restricted.
    }
  }
  if (projectMatch) {
    const projectId = projectMatch[1];
    const ownerKey = `souunnds.project-owner.${projectId}`;
    const stateKey = `souunnds.project-state.${projectId}`;
    const revisionKey = `souunnds.project-revision.${projectId}`;
    const dirtyKey = `souunnds.project-dirty.${projectId}`;
    let ownerCapability = "";
    let cachedState = "";
    let cachedRevision = 0;
    let hasCachedState = false;
    let keepLocalDraft = false;
    try {
      const owner = JSON.parse(window.localStorage.getItem(ownerKey) ?? "null");
      if (typeof owner?.capability === "string") ownerCapability = owner.capability;
      cachedState = window.localStorage.getItem(stateKey) ?? "";
      const parsedState = JSON.parse(cachedState || "null");
      hasCachedState = !!parsedState && typeof parsedState === "object" && !Array.isArray(parsedState);
      const revision = Number(window.localStorage.getItem(revisionKey));
      if (Number.isSafeInteger(revision) && revision > 0) cachedRevision = revision;
      keepLocalDraft = !!ownerCapability && hasCachedState && cachedRevision > 0
        && window.localStorage.getItem(dirtyKey) === "true";
    } catch {
      // Restricted storage should not prevent a public share from loading.
    }
    try {
      const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 404) throw new Error("This shared project was not found.");
        throw new Error("Could not load this shared project.");
      }
      const project = await response.json() as {
        revision: number;
        manifest: { state: unknown };
      };
      if (!Number.isSafeInteger(project.revision) || project.revision < 1
        || !project.manifest?.state || typeof project.manifest.state !== "object") {
        throw new Error("This shared project is invalid.");
      }
      if (!keepLocalDraft) {
        window.localStorage.setItem(stateKey, JSON.stringify(project.manifest.state));
        window.localStorage.setItem(revisionKey, String(project.revision));
        window.localStorage.setItem(dirtyKey, "false");
      }
      try {
        window.sessionStorage.setItem("souunnds.open-project", JSON.stringify({
          id: projectId,
          revision: keepLocalDraft ? cachedRevision : project.revision,
          ...(keepLocalDraft && project.revision > cachedRevision ? { conflictRevision: project.revision } : {}),
        }));
      } catch {
        // Project data is already cached locally if session storage is unavailable.
      }
    } catch (error) {
      if (error instanceof Error && error.message === "This shared project was not found.") {
        root.render(createElement("main", { className: "project-load-error", role: "alert" }, error.message));
        return;
      }
      if (!ownerCapability || !hasCachedState || cachedRevision < 1) {
        root.render(createElement("main", { className: "project-load-error", role: "alert" }, error instanceof Error ? error.message : "Could not load project."));
        return;
      }
      try {
        window.sessionStorage.setItem("souunnds.open-project", JSON.stringify({ id: projectId, revision: cachedRevision }));
      } catch {
        // The local project state can still be edited without session storage.
      }
    }
  }
  // The app reads persisted workspace state at module initialization, so install the shared-project cache first.
  const { App } = await import("./App");
  root.render(<StrictMode><App /></StrictMode>);
}

void start();
