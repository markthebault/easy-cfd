export const NATIVE_OPENFOAM_ENABLED = import.meta.env.VITE_ENABLE_OPENFOAM === "true";

export interface RemoteConnection { baseUrl: string; token: string }
const CONNECTION_KEY = "easycfd.remoteOpenfoam";

/** Accept a server root or an API prefix. Keep the token out of API URLs and saved runs. */
export function parseRemoteUrl(value: string): RemoteConnection {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Enter a complete backend URL, including https:// and ?token=…."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("Use HTTPS for a remote server. HTTP is supported for localhost testing.");
  if (url.username || url.password || url.hash)
    throw new Error("Use a URL without a username, password or fragment.");
  const tokens = url.searchParams.getAll("token");
  if (tokens.length !== 1 || !tokens[0].trim()) throw new Error("The backend URL needs one non-empty ?token=… parameter.");
  if ([...url.searchParams.keys()].some(key => key !== "token"))
    throw new Error("The backend URL can only include the token query parameter.");
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api") ? path : `${path}/api`;
  return { baseUrl: url.toString().replace(/\/+$/, ""), token: tokens[0] };
}

function restore(): RemoteConnection | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CONNECTION_KEY) ?? "null");
    if (!saved) return null;
    return parseRemoteUrl(`${saved.baseUrl}?token=${encodeURIComponent(saved.token)}`);
  } catch { return null; }
}
let remote = restore();
export const getRemoteConnection = () => remote;
export const backendAvailable = () => NATIVE_OPENFOAM_ENABLED || !!remote;
/** Stable endpoint identity for caches; never contains a credential. */
export const backendIdentity = () => remote?.baseUrl ?? "local";
export const backendStorageKey = (key: string) => remote ? `${key}:${remote.baseUrl}` : key;

export function setRemoteConnection(connection: RemoteConnection | null) {
  // Session storage reconnects on reload, and clears the token when this tab is closed.
  if (connection) sessionStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
  else sessionStorage.removeItem(CONNECTION_KEY);
  remote = connection;
}

export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!backendAvailable()) throw new Error("Connect a remote OpenFOAM server to use this engine.");
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path.");
  const connection = remote;
  const headers = new Headers(init.headers);
  if (connection) {
    headers.set("Authorization", `Bearer ${connection.token}`);
    headers.set("ngrok-skip-browser-warning", "1");
  }
  return fetch(`${connection?.baseUrl ?? "/api"}${path}`, {
    ...init, headers, credentials: "omit", redirect: "error", cache: "no-store",
  });
}
