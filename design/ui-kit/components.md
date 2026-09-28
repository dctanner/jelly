# Component specification

| Component | Behavior and states |
| --- | --- |
| Agent row | 46 px circular avatar, name, role or working/needs-help copy, selected background; persistent identity across scope changes. |
| Project switcher | Anchored desktop dialog; mobile bottom sheet. Search, recent-first named projects, All agents/Ungrouped, counts and background work/help labels. Cmd/Ctrl+K, arrows, Enter, Escape. |
| Composer | 16 px text, growing field, 44 px send/stop target. Disabled when stale, archived, disconnected or busy. Draft belongs to agent ID. Touch Enter inserts a line break. |
| Message | Right-aligned blue user bubble, open assistant reading column, safe headings/lists/inline code/fenced code/HTTP links. Copy action. Maximum reading width 720 px. |
| Tool disclosure | Summary with status text; expanded output wraps and scrolls. Never insert tool output as HTML. |
| Working indicator | 42 × 50 px mark and a real working label. Static for handoffs; stop has a pending state. |
| Project form | Required 1–60 character unique name and explicitly selected server directory. Error retains form values. Update explains future-agent-only inheritance. |
| Directory picker | Server identity, canonical path, Home/parent/breadcrumbs, hidden toggle, 100-entry pages, retry, unavailable children, empty folder, explicit pinned confirmation. |
| Agent profile | Twelve avatar choices, optional project during creation, inherited/effective cwd, name, role and instructions. Metadata move is separate from busy-restricted edits. |
| Dialog / sheet | Native dialog for modality, focus containment, Escape, return focus, animated close. Bottom-aligned on mobile; folder sheet uses available height. |
| Archive | Scope-filtered paginated archive, history review and restore. Deleting project metadata includes archived membership. |
| Computer / handoff | Existing private control protocol retained, responsive panel, take/return control and connection errors. |

Spacing and initial design tokens are in `tokens.json`. Production CSS maps these to existing app semantic variables. Desktop sidebar 280 px, 304 px at 1440; mobile breakpoint 768. Controls have clear focus rings, textual states and minimum 44 px primary targets.
