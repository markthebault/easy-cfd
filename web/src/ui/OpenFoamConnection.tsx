import { useState } from "react";
import { OPENFOAM_ENABLED } from "../engine/features";
import { getRemoteConnection } from "../engine/connection";
import { app, checkServer, connectOpenFoam } from "../store/app";
import { useStore } from "../store/store";
import { BACKEND_IMAGE, DOCKER_START_COMMAND } from "../engine/dockerSetup";

export function OpenFoamConnection() {
  const server = useStore(app, s => s.server);
  const busy = useStore(app, s => !!s.busy || s.view === "live");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const remote = getRemoteConnection();
  const pending = server.status === "checking";
  const connect = async (value: string | null) => {
    setError("");
    try { await connectOpenFoam(value); setUrl(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const copyCommand = async () => {
    setCopyError("");
    try { await navigator.clipboard.writeText(DOCKER_START_COMMAND); setCopied(true); }
    catch { setCopyError("Select the command below and copy it manually."); }
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
    <div className="docker-setup" data-testid="docker-setup">
      <h4 className="docker-setup-title">Start your server with Docker</h4>
      <p className="field-hint">Start Docker, then paste this into a macOS or Linux terminal. It downloads OpenFOAM and starts the server on your computer.</p>
      <button className="btn ghost sm" type="button" onClick={()=>void copyCommand()} data-testid="copy-docker-command">
        {copied ? "Copied" : "Copy startup command"}
      </button>
      <pre className="docker-command" tabIndex={0} aria-label="Docker startup command"><code>{DOCKER_START_COMMAND}</code></pre>
      {copyError && <p className="inline-error" role="status">{copyError}</p>}
      <p className="field-hint">Copy the <code>http://localhost:8000?token=…</code> URL printed in the terminal into the connection field above. Allow local-network access if your browser asks.</p>
      <p className="field-hint">Keep the terminal open while using the server. After runs finish, press <code>Ctrl+C</code> to stop it; the container is removed automatically. Runs and the connection token stay in <code>~/easycfd-data</code>. Paste the command again to restart.</p>
      <p className="field-hint">The server uses your Docker daemon to run simulations.</p>
      <p className="field-hint">For a server on another computer, expose it over HTTPS and paste its URL with the same token.</p>
      <a className="small" href={`https://hub.docker.com/r/${BACKEND_IMAGE.split(":")[0]}`} target="_blank" rel="noreferrer">Docker image and setup guide</a>
    </div>
    {(error || server.error) && <p className="inline-error" role="alert">{error || server.error}</p>}
  </details>;
}
