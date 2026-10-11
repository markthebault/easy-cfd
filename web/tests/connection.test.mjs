import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

let server, connection, originalFetch;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, logLevel: "error", appType: "custom" });
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  connection = await server.ssrLoadModule("/src/engine/connection.ts");
  originalFetch = globalThis.fetch;
});
after(async () => { globalThis.fetch = originalFetch; delete globalThis.sessionStorage; await server.close(); });

test("connection URLs support HTTPS, API prefixes and loopback HTTP with encoded tokens", () => {
  assert.deepEqual(connection.parseRemoteUrl("https://cfd.example/?token=a%2Bb%3Dc"), {baseUrl:"https://cfd.example/api", token:"a+b=c"});
  assert.deepEqual(connection.parseRemoteUrl("https://cfd.example/proxy/api/?token=secret"), {baseUrl:"https://cfd.example/proxy/api", token:"secret"});
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    assert.equal(connection.parseRemoteUrl(`http://${host}:8000?token=secret`).baseUrl, `http://${host}:8000/api`);
  for (const url of ["http://internet.example?token=x", "ftp://cfd.example?token=x", "https://cfd.example", "https://cfd.example?token=", "https://user:password@cfd.example?token=x", "https://cfd.example?token=x&token=y", "https://cfd.example?token=x&other=y", "https://cfd.example?token=x#hash"])
    assert.throws(() => connection.parseRemoteUrl(url));
});

test("remote API authenticates JSON, multipart and binary requests without putting tokens in URLs or cache keys", async () => {
  const remote = connection.parseRemoteUrl("https://cfd.example?token=test-secret");
  connection.setRemoteConnection(remote);
  const requests = [];
  globalThis.fetch = async (url, init) => {requests.push({url,init});return new Response("{}", {headers:{"Content-Type":"application/json"}});};
  for (const body of [JSON.stringify({name:"test"}),new FormData(),new Uint8Array([1,2,3])])
    await connection.backendFetch("/projects", {method:"POST",body});
  for (const {url,init} of requests) {
    assert.equal(url,"https://cfd.example/api/projects");
    assert.equal(init.headers.get("Authorization"),"Bearer test-secret");
    assert.equal(init.headers.get("ngrok-skip-browser-warning"),"1");
    assert.equal(init.credentials,"omit");
    assert.equal(init.redirect,"error");
  }
  assert.equal(connection.backendIdentity(),"https://cfd.example/api");
  assert.equal(connection.backendStorageKey("projects"),"projects:https://cfd.example/api");
  connection.setRemoteConnection(null);
});
