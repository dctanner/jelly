import { useState } from "react";
import { ChevronsUpDown, Plus } from "lucide-react";
import type { AppRecord } from "../shared/apps";
import type { Snapshot, ProjectRecord } from "../shared/types";
import { Modal } from "./Modal";
import { ProjectForm } from "./Projects";

export interface AppEditIntent {
  app: AppRecord;
  id: string;
}
export function appEditDraft(app: AppRecord) {
  return `I'd like to edit the app “${app.name}” (app ID: ${app.id}). Inspect its project and registered URL. Jelly does not own its hosting. Ask before changing its service or registration.\n\nMy changes: `;
}

/** Choosing a normal workspace prepares a draft; it never submits a model request. */
export function AppEditor({
  intent,
  data,
  connected,
  onClose,
  onChoose,
  onCreate,
  onProject,
}: {
  intent: AppEditIntent;
  data: Snapshot;
  connected: boolean;
  onClose: () => void;
  onChoose: (id: string) => void;
  onCreate: (projectId: string | null) => Promise<void>;
  onProject: (project: ProjectRecord) => void;
}) {
  const builder = data.agents.find(
    (agent) => agent.id === intent.app.builderAgentId && !agent.archivedAt,
  );
  const initialProject = builder?.projectId ?? intent.app.projectId;
  const [projectId, setProjectId] = useState(
    initialProject &&
      data.projects.some((project) => project.id === initialProject)
      ? initialProject
      : "",
  );
  const [agentId, setAgentId] = useState(
    builder && (builder.projectId ?? "") === projectId ? builder.id : "",
  );
  const [newProject, setNewProject] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = data.agents.filter(
    (agent) => !agent.archivedAt && (agent.projectId ?? "") === projectId,
  );
  async function proceed() {
    if (busy || !connected) return;
    if (agentId && available.some((agent) => agent.id === agentId)) {
      onChoose(agentId);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onCreate(projectId || null);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  if (newProject)
    return (
      <ProjectForm
        instance={data.instance.name}
        count={0}
        onClose={() => setNewProject(false)}
        onSaved={(project) => {
          onProject(project);
          setProjectId(project.id);
          setAgentId("");
          setNewProject(false);
        }}
        onDeleted={() => setNewProject(false)}
      />
    );
  return (
    <Modal
      title={`Edit ${intent.app.name} with agent`}
      className="apps-sheet"
      onClose={onClose}
      dismissible={!busy}
    >
      <p className="apps-sheet-message">
        Choose a conversation or create a normal agent. Jelly will prepare an
        unsent draft for you to describe your changes. Nothing is sent automatically.
      </p>
      <div className="settings-group apps-editor-group">
        <label className="apps-select-row">
          <span>Project</span>
          <select
            value={projectId}
            disabled={busy}
            onChange={(event) => {
              setProjectId(event.target.value);
              setAgentId("");
            }}
          >
            <option value="">Unassigned</option>
            {data.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <ChevronsUpDown size={16} aria-hidden="true" />
        </label>
        <button
          type="button"
          className="apps-row-button"
          disabled={busy || !connected}
          onClick={() => setNewProject(true)}
        >
          <Plus size={18} aria-hidden="true" />
          Create a project
        </button>
      </div>
      <div className="settings-group apps-editor-group">
        <label className="apps-select-row">
          <span>Agent</span>
          <select
            value={agentId}
            disabled={busy}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">Create a new agent</option>
            {available.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <ChevronsUpDown size={16} aria-hidden="true" />
        </label>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error} Try again below.
        </p>
      )}
      <div className="apps-detail-actions">
        <button
          className="primary"
          disabled={busy || !connected}
          onClick={() => void proceed()}
        >
          {busy ? "Creating agent…" : "Prepare draft"}
        </button>
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
