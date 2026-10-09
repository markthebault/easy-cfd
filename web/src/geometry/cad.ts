import workerUrl from "./cad.worker.js?url&no-inline";
import scriptUrl from "occt-import-js/dist/occt-import-js.js?url";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import type { RawMesh, SourceFile } from "./model";

/** Read STEP/IGES locally. A bounded worker keeps CAD parsing off the UI thread. */
export function readCAD(file: SourceFile): Promise<RawMesh[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    const timeout = setTimeout(() => finish(new Error("CAD import took longer than five minutes. Try a smaller exterior model.")), 300_000);
    const finish = (error?: Error, meshes?: RawMesh[]) => {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error); else resolve(meshes!);
    };
    worker.onerror = () => finish(new Error("The CAD reader could not start. Reload the page and try again."));
    worker.onmessage = ({ data }: MessageEvent<{ error?: string; meshes?: { name: string; positions: Float32Array }[] }>) => {
      if (data.error) return finish(new Error(`${file.name}: ${data.error}`));
      finish(undefined, data.meshes!.map(mesh => ({ ...mesh, file: file.name, units: "m" })));
    };
    // Preserve the original ArrayBuffer in the design's local file store.
    const bytes = file.bytes.slice(0);
    worker.postMessage({ bytes, iges: /\.(igs|iges)$/i.test(file.name), script: new URL(scriptUrl, location.href).href, wasm: new URL(wasmUrl, location.href).href }, [bytes]);
  });
}
