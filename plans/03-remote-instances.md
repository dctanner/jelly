# Phase 3 — Remote connections and multiple instances

- [ ] Add a connection flow accepting a Jelly server address and remote authentication.
- [ ] Define and implement secure transport, server access credentials, client credential storage and revocation. Extend the local browser/CSRF and desktop-ticket boundaries for authenticated remote use.
- [ ] Save multiple instance connections and provide an easy local/remote switcher.
- [ ] Show the selected instance, remote connection health and running work; isolate each instance's selection, drafts, event cursor and cached state.
- [ ] Adapt snapshot/event recovery to remote network loss, expired authentication and switching while runs are active.
- [ ] Make ChatGPT sign-in/callbacks and browser/password handoffs work when the UI and Jelly server are on different computers.
- [ ] Test two real server instances: switch between them, close/reopen the client, revoke access, and recover without mixing data or duplicating actions.

## Exit criteria

One client can securely connect to and switch between a local and a remote Jelly server. Remote execution survives client closure, and reconnecting restores the correct instance's current activity.
