# Screen and state inventory

Fixture scenarios in the screen explorer. Production shows only real server state; it does not fabricate token streaming (the current server publishes completed tool/turn events).

| Screen | State | Default surface |
| --- | --- | --- |
| [Conversation · desktop](../screens/index.html?screen=desktop-chat) | ready | desktop · light |
| [Agents · mobile](../screens/index.html?screen=mobile-inbox) | inbox | mobile · light |
| [Conversation · mobile](../screens/index.html?screen=mobile-chat) | ready | mobile · light |
| [Conversation · tablet](../screens/index.html?screen=tablet-chat) | ready | tablet · light |
| [Conversation · dark](../screens/index.html?screen=dark-chat) | ready | desktop · dark |
| [Switch project](../screens/index.html?screen=project-switcher) | switcher | desktop · light |
| [Empty project](../screens/index.html?screen=project-empty) | project-empty | desktop · light |
| [Create project](../screens/index.html?screen=create-project) | create-project | desktop · light |
| [Choose project folder](../screens/index.html?screen=folder-browser) | folder-browser | desktop · light |
| [Folder unavailable](../screens/index.html?screen=folder-error) | folder-error | desktop · light |
| [Project settings](../screens/index.html?screen=project-settings) | project-settings | desktop · light |
| [Delete project](../screens/index.html?screen=delete-project) | delete-project | desktop · light |
| [Move agent](../screens/index.html?screen=move-agent) | move-agent | desktop · light |
| [Create agent · inherited folder](../screens/index.html?screen=create-agent) | create-agent | desktop · light |
| [Choose sea avatar](../screens/index.html?screen=avatar-picker) | avatar-picker | desktop · light |
| [Agent profile](../screens/index.html?screen=edit-agent) | edit-agent | desktop · light |
| [Archived agents](../screens/index.html?screen=archived-agent) | archived | desktop · light |
| [Empty archive](../screens/index.html?screen=archive-empty) | archive-empty | desktop · light |
| [New conversation](../screens/index.html?screen=agent-empty) | agent-empty | desktop · light |
| [Loading conversation](../screens/index.html?screen=chat-loading) | loading | desktop · light |
| [Agent working](../screens/index.html?screen=working) | working | desktop · light |
| [Streaming response](../screens/index.html?screen=streaming) | streaming | desktop · light |
| [Tool activity](../screens/index.html?screen=tool-expanded) | tool | desktop · light |
| [Long response & code](../screens/index.html?screen=long-message) | long | desktop · light |
| [Approval needed](../screens/index.html?screen=waiting-sudo) | sudo | desktop · light |
| [Browser handoff](../screens/index.html?screen=waiting-browser) | handoff | desktop · light |
| [Run failed](../screens/index.html?screen=run-error) | error | desktop · light |
| [Interrupted after restart](../screens/index.html?screen=interrupted) | interrupted | desktop · light |
| [Stopping work](../screens/index.html?screen=cancelling) | cancelling | desktop · light |
| [Stopped by you](../screens/index.html?screen=cancelled) | cancelled | desktop · light |
| [Offline · retained draft](../screens/index.html?screen=offline) | offline | desktop · light |
| [Reconnecting](../screens/index.html?screen=reconnecting) | reconnecting | desktop · light |
| [Earlier messages](../screens/index.html?screen=history-loading) | history | desktop · light |
| [Settings](../screens/index.html?screen=settings) | settings | desktop · light |
| [Connect an account](../screens/index.html?screen=connection-required) | connection | desktop · light |
| [Complete sign-in](../screens/index.html?screen=login-waiting) | login | desktop · light |
| [Connection error](../screens/index.html?screen=api-error) | api-error | desktop · light |
| [Computer ready](../screens/index.html?screen=computer-ready) | computer | desktop · light |
| [Computer · your turn](../screens/index.html?screen=computer-human) | computer-human | desktop · light |
| [Computer unavailable](../screens/index.html?screen=computer-error) | computer-error | desktop · light |

All scenarios can be reviewed in both themes and each viewport. Working, waiting, stopped, failure, interrupted, loading, archive, account connection, folder errors and Computer handoffs retain explicit status copy. Stop only affects the active run; switching scopes never stops work.
