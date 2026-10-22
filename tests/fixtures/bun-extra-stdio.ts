import childProcess, { type ChildProcess } from "node:child_process";

// Bun 1.3.9 can finalize retired extra-stdio wrappers after their FD numbers
// are reused, closing live browser pipes or unrelated files. A minimal repro
// retires two five-stdio children, launches a third, then calls Bun.gc(true):
// the third receives EOF unless the retired ChildProcess objects are retained.
// Keep these Playwright resources for the bounded test process lifetime.
// This does not keep children running or change cleanup/exit assertions.
const browserProcesses = new Set<ChildProcess>();
const originalSpawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
  const child = originalSpawn(...args);
  const stdio = args[2]?.stdio;
  if (Array.isArray(stdio) && stdio.length > 3) browserProcesses.add(child);
  return child;
}) as typeof childProcess.spawn;
