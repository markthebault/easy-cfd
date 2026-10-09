// Classic worker: OpenCascade's bundled runtime uses importScripts in browsers.
let engine;
self.onmessage = async ({ data }) => {
  try {
    if (!engine) {
      importScripts(data.script);
      engine = await occtimportjs({ locateFile: () => data.wasm });
    }
    const params = { linearUnit: "meter", linearDeflectionType: "absolute_value", linearDeflection: 0.0005, angularDeflection: 0.3 };
    const result = data.iges ? engine.ReadIgesFile(new Uint8Array(data.bytes), params) : engine.ReadStepFile(new Uint8Array(data.bytes), params);
    if (!result.success || !result.meshes?.length) throw new Error("No surfaces could be read from this CAD file.");
    const triangles = result.meshes.reduce((sum, mesh) => sum + mesh.index.array.length / 3, 0);
    if (triangles > 3_000_000) throw new Error("This CAD file exceeds the 3,000,000-triangle import limit.");
    const meshes = result.meshes.map((mesh, i) => {
      const vertices = mesh.attributes.position.array;
      const positions = new Float32Array(mesh.index.array.length * 3);
      mesh.index.array.forEach((index, j) => {
        positions[j * 3] = vertices[index * 3];
        positions[j * 3 + 1] = vertices[index * 3 + 1];
        positions[j * 3 + 2] = vertices[index * 3 + 2];
      });
      // Float32 collapses a few CAD slivers to repeated vertices. Omit only
      // zero-area triangles; otherwise these degenerate faces create false holes.
      let written = 0;
      for (let t = 0; t < positions.length; t += 9) {
        const ax=positions[t+3]-positions[t], ay=positions[t+4]-positions[t+1], az=positions[t+5]-positions[t+2];
        const bx=positions[t+6]-positions[t], by=positions[t+7]-positions[t+1], bz=positions[t+8]-positions[t+2];
        const cx=ay*bz-az*by, cy=az*bx-ax*bz, cz=ax*by-ay*bx;
        if (cx*cx+cy*cy+cz*cz < 4e-32) continue;
        positions.copyWithin(written, t, t+9); written += 9;
      }
      return { name: mesh.name || `CAD part ${i + 1}`, positions: positions.slice(0,written) };
    });
    self.postMessage({ meshes }, meshes.map(mesh => mesh.positions.buffer));
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
