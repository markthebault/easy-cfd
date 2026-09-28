// IndexedDB persistence. Designs and runs are small documents; fields and source files are large
// blobs kept in their own stores so listing designs never loads them.

import type { DesignDoc, FieldDoc, FileDoc, RunDoc } from "./types";

const NAME = "easycfd-web";
const VERSION = 1;

interface Stores {
  designs: DesignDoc;
  runs: RunDoc;
  fields: FieldDoc;
  files: FileDoc;
}
type StoreName = keyof Stores;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("designs")) db.createObjectStore("designs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("runs")) db.createObjectStore("runs", { keyPath: "id" }).createIndex("design", "designId");
      if (!db.objectStoreNames.contains("fields")) db.createObjectStore("fields", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "hash" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open the browser database."));
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<K extends StoreName>(name: K, mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function put<K extends StoreName>(name: K, value: Stores[K]): Promise<void> {
  await wrap((await tx(name, "readwrite")).put(value));
}

export async function get<K extends StoreName>(name: K, key: string): Promise<Stores[K] | undefined> {
  return wrap((await tx(name, "readonly")).get(key)) as Promise<Stores[K] | undefined>;
}

export async function getAll<K extends StoreName>(name: K): Promise<Stores[K][]> {
  return wrap((await tx(name, "readonly")).getAll()) as Promise<Stores[K][]>;
}

export async function remove(name: StoreName, key: string): Promise<void> {
  await wrap((await tx(name, "readwrite")).delete(key));
}

export async function hasKey(name: StoreName, key: string): Promise<boolean> {
  return (await wrap((await tx(name, "readonly")).count(key))) > 0;
}

/** Delete source files no design or run refers to any more. */
export async function collectFiles(): Promise<void> {
  const [designs, runs, files] = await Promise.all([getAll("designs"), getAll("runs"), wrap((await tx("files", "readonly")).getAllKeys())]);
  const used = new Set<string>();
  for (const d of [...designs, ...runs]) if (d.source.kind === "files") for (const f of d.source.files) used.add(f.hash);
  for (const key of files) if (!used.has(String(key))) await remove("files", String(key));
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  if (crypto.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Insecure contexts have no SubtleCrypto; a random key still works, it only loses deduplication.
  return `r${crypto.getRandomValues(new Uint32Array(4)).join("")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
