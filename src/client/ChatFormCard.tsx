import { useId, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import "./ChatFormCard.css";

/** Default shell for inline requests/forms. Unlike a modal, it never traps
 * focus or steals it from the composer when a request arrives. */
export function ChatFormCard({
  title,
  label,
  icon,
  status = "Needs your input",
  description,
  error,
  children,
}: {
  title: string;
  label?: string;
  icon: ReactNode;
  status?: string;
  description?: string;
  error?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      className="chat-form-card"
      aria-label={label}
      aria-labelledby={label ? undefined : `${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
    >
      <header className="chat-form-header">
        <span className="chat-form-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="chat-form-heading">
          <h3 id={`${id}-title`}>{title}</h3>
          <span className="chat-form-status">{status}</span>
        </div>
      </header>
      <div className="chat-form-body">
        {description && (
          <p className="chat-form-description" id={`${id}-description`}>
            {description}
          </p>
        )}
        {error && (
          <p className="chat-form-error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

/** Secondary action first, primary submit/continue action last. */
export function ChatFormActions({ children }: { children: ReactNode }) {
  return <div className="chat-form-actions">{children}</div>;
}
