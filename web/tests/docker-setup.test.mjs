import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "vite";

test("the copied startup command is a single valid Docker run command",async()=>{
  const server=await createServer({ optimizeDeps: {noDiscovery: true, include: []}, server:{middlewareMode:true,hmr:false},logLevel:"error",appType:"custom"});
  try{
    const {DOCKER_START_COMMAND}=await server.ssrLoadModule("/src/engine/dockerSetup.ts");
    assert.ok(DOCKER_START_COMMAND.startsWith("docker run -it --rm "));
    assert.ok(!DOCKER_START_COMMAND.includes("mkdir"));
    assert.ok(!DOCKER_START_COMMAND.includes("docker pull"));
    const syntax=spawnSync("bash",["-n"],{input:DOCKER_START_COMMAND,encoding:"utf8"});
    assert.equal(syntax.status,0,syntax.stderr);
  }finally{await server.close();}
});
