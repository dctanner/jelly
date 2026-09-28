# Core flows

**Start without a project.** All agents is the default. Create agent defaults to Ungrouped and a Jelly-managed private directory. No project setup is required.

**Create a project.** Switcher → New project → name → Choose folder → navigate the connected server → Use this folder → Create project. The empty project offers create and add-existing actions. Canceling the picker preserves the name and prior selection.

**Switch.** Project button → visible project. Cached directory filters immediately. Destination remembers the last eligible agent, otherwise retains the current eligible agent or chooses the first stable member. Empty scope sends `selection=none`. History from the previous scope is never sendable or shown as the destination. Drafts remain keyed by agent. Navigation never sends Stop.

**Create inside a project.** Profile defaults to the current named project and shows inherited cwd. The server reads its authoritative default in the creation transaction. User may instead select another project or Ungrouped.

**Move.** Agent action → Move to project → destination. Same agent, conversation and cwd. Running/waiting agents can move. Explicit move follows the agent to its destination; remote moves reconcile the current view without moving the user's scope.

**Change the folder.** Project settings → Change folder → Use this folder → Save. New agents inherit the replacement. Existing agents retain their original persisted cwd.

**Delete.** Project settings → Delete → explicit confirmation. Active and archived members become ungrouped; no files, history, context or directories are deleted. Remote clients recover to a valid view.

**Work and handoff.** Send → working mark → tool/turn updates → complete, failed, interrupted or stopped. Browser handoff pauses animation; private Computer control remains explicit. Sudo credentials stay in the existing private approval channel, never ordinary chat.
