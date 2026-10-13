import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "vite";

test("the copied startup command downloads the backend's actual solver and is valid shell",async()=>{
  const server=await createServer({server:{middlewareMode:true,hmr:false},logLevel:"error",appType:"custom"});
  try{
    const {SOLVER_IMAGE,DOCKER_START_COMMAND}=await server.ssrLoadModule("/src/engine/dockerSetup.ts");
    const backend=await readFile(new URL("../../backend/easycfd/foam.py",import.meta.url),"utf8");
    assert.equal(SOLVER_IMAGE,backend.match(/^IMAGE = "([^"]+)"/m)[1]);
    assert.ok(DOCKER_START_COMMAND.includes(`docker pull ${SOLVER_IMAGE}`));
    const syntax=spawnSync("bash",["-n"],{input:DOCKER_START_COMMAND,encoding:"utf8"});
    assert.equal(syntax.status,0,syntax.stderr);
  }finally{await server.close();}
});
