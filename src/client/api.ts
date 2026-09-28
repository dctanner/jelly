export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not reach Jelly.");
  return data as T;
}
export const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
let csrfPromise: Promise<string> | undefined;
export async function control<T>(
  path: string,
  data: unknown = {},
  retry = true,
): Promise<T> {
  csrfPromise ??= api<{ csrf: string }>("/control-session")
    .then((v) => v.csrf)
    .catch((e) => {
      csrfPromise = undefined;
      throw e;
    });
  const csrf = await csrfPromise;
  try {
    return await api<T>(path, {
      method: "POST",
      headers: { "x-jelly-csrf": csrf },
      body: JSON.stringify(data),
    });
  } catch (e) {
    if (
      (e as Error).message.includes("control session") ||
      (e as Error).message.includes("control token")
    ) {
      csrfPromise = undefined;
      if (retry) return control<T>(path, data, false);
    }
    throw e;
  }
}
/** Directory and project control uses the same session/token as Computer. */
export async function projectApi<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  csrfPromise ??= api<{ csrf: string }>("/control-session")
    .then((v) => v.csrf)
    .catch((e) => {
      csrfPromise = undefined;
      throw e;
    });
  try {
    return await api<T>(path, {
      ...options,
      headers: { ...options.headers, "x-jelly-csrf": await csrfPromise },
    });
  } catch (e) {
    if (retry && /control session|control token/.test((e as Error).message)) {
      csrfPromise = undefined;
      return projectApi<T>(path, options, false);
    }
    throw e;
  }
}
