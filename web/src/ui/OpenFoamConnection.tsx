import { useState } from "react";
import { OPENFOAM_ENABLED } from "../engine/features";
import { getRemoteConnection } from "../engine/connection";
import { app, checkServer, connectOpenFoam } from "../store/app";
import { useStore } from "../store/store";

export function OpenFoamConnection() {
  const server = useStore(app, s => s.server);
  const busy = useStore(app, s => !!s.busy || s.view === "live");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const remote = getRemoteConnection();
  const pending = server.status === "checking";
  const connect = async (value: string | null) => {
    setError("");
    try { await connectOpenFoam(value); setUrl(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <details className="group remote-connection" open={!!remote || undefined}>
    <summary>OpenFOAM server connection</summary>
    <form onSubmit={e => { e.preventDefault(); void connect(url); }}>
      <label className="field-label" htmlFor="openfoam-url">Remote backend URL with token</label>
      <input id="openfoam-url" type="password" autoComplete="off" spellCheck={false}
        placeholder="https://your-server.example?token=…" value={url}
        onChange={e => setUrl(e.target.value)} disabled={busy || pending} />
      <div className="remote-connection-actions">
        <button className="btn ghost sm" type="submit" disabled={busy || pending || !url.trim()}>
          {pending ? "Connecting…" : "Connect remote server"}
        </button>
        {remote && <button className="btn ghost sm" type="button" disabled={busy || pending}
          onClick={() => void connect(null)}>{OPENFOAM_ENABLED ? "Use native server" : "Disconnect"}</button>}
        {(remote || OPENFOAM_ENABLED) && <button className="btn ghost sm" type="button"
          disabled={busy || pending} onClick={() => void checkServer()}>Retry connection</button>}
      </div>
    </form>
    <p className="field-hint">{remote ? `Remote server: ${remote.baseUrl}` : OPENFOAM_ENABLED ? "Using the native server on this site." : "A remote server works with this edition of EasyCFD."}</p>
    <p className="field-hint">The connection is saved for this browser tab. Server runs upload your model to the connected server.</p>
    {(error || server.error) && <p className="inline-error" role="alert">{error || server.error}</p>}
  </details>;
}
