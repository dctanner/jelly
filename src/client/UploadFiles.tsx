import { useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { DirectoryPicker } from "./Projects";
import { projectApi } from "./api";
import type { AgentRecord } from "../shared/types";
import "./UploadFiles.css";

export function UploadFiles({
  agent,
  instance,
  onClose,
  onUploaded,
}: {
  agent: AgentRecord;
  instance: string;
  onClose: () => void;
  onUploaded: (name: string) => void;
}) {
  const [directory, setDirectory] = useState(agent.cwd);
  const [browsing, setBrowsing] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const uploading = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (uploading.current || !files.length || !directory) return;
    uploading.current = true;
    setBusy(true);
    setErrors([]);
    const failed: File[] = [];
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      setStatus(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
      try {
        const query = new URLSearchParams({ directory, name: file.name });
        const result = await projectApi<{ name: string }>(
          `/agents/${agent.id}/uploads?${query}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
          },
        );
        onUploaded(result.name);
      } catch (error) {
        failed.push(file);
        failures.push(`${file.name}: ${(error as Error).message}`);
      }
    }
    setFiles(failed);
    if (input.current) input.current.value = "";
    setErrors(failures);
    setStatus("");
    setBusy(false);
    uploading.current = false;
    if (!failed.length) onClose();
  }

  return (
    <>
      <Modal
        title="Upload file"
        dismissible={!busy}
        onClose={onClose}
        className="upload-dialog"
      >
        <form onSubmit={submit}>
          <p className="subtle">
            Upload to {instance}. Each uploaded file name is added to{" "}
            {agent.name}’s message.
          </p>
          <label>
            Files
            <input
              ref={input}
              type="file"
              multiple
              disabled={busy}
              onChange={(event) => {
                setFiles(Array.from(event.target.files ?? []));
                setErrors([]);
              }}
            />
          </label>
          {!!files.length && (
            <ul className="upload-files">
              {files.map((file, index) => (
                <li key={index}>{file.name}</li>
              ))}
            </ul>
          )}
          <label>
            Destination folder
            <input
              value={directory}
              required
              disabled={busy}
              onChange={(event) => setDirectory(event.target.value)}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setBrowsing(true)}
          >
            Browse host folders
          </button>
          <p className="subtle">
            Use an absolute folder path on the host. Existing files are kept.
          </p>
          {errors.map((error, index) => (
            <p key={index} className="error-text" role="alert">
              {error}
            </p>
          ))}
          {status && <p role="status">{status}</p>}
          <button
            className="primary wide"
            disabled={busy || !files.length || !directory}
          >
            {busy
              ? "Uploading…"
              : errors.length
                ? "Retry failed uploads"
                : "Upload"}
          </button>
        </form>
      </Modal>
      {browsing && (
        <DirectoryPicker
          initial={
            agent.managedCwd && directory === agent.cwd ? undefined : directory
          }
          instance={instance}
          onClose={() => setBrowsing(false)}
          onChoose={(path) => {
            setDirectory(path);
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}
