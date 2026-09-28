# Information architecture

Instance → optional Projects → Agents → Conversations / Runs / Interventions.

All agents and Ungrouped are derived scopes across the full active-agent directory. Named projects exist even when empty. Archives use the current scope but do not contribute to active counts. Instance selection and account/model settings remain distinct from project selection.

Project owns a default cwd. Agent owns an immutable effective cwd, avatar, profile, history and runtime context. Group membership can change independently. Browser owns current scope, last selection per scope and recent projects, namespaced by instance ID. Drafts are in memory per agent, matching the pre-existing persistence scope.
