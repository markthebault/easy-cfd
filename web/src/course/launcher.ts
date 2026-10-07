// A fixed local teaching pack, loaded only after following the course's explicit lab link.
import { app, flushDesignSave, importFiles, renameCurrent, renameGroup, setGroupEnabled, toast } from '../store/app';
import { put } from '../store/db';
import { DEFAULT_SETTINGS } from '../solver/types';

interface CourseFile { file: string; name: string; base?: boolean; group: string }
export async function launchCourseLab() {
  const base = `${import.meta.env.BASE_URL}course/models/`;
  const manifestResponse = await fetch(`${base}manifest.json`);
  if (!manifestResponse.ok) throw new Error('The course teaching pack could not be loaded.');
  const manifest = await manifestResponse.json() as { version: number; files: CourseFile[] };
  if (manifest.version !== 1 || manifest.files.length !== 12 || manifest.files.some(f => !/^[a-z0-9_]+\.stl$/.test(f.file))) throw new Error('The course teaching pack is incomplete.');
  // Fetch everything before changing the active design, so an unavailable pack preserves it.
  const files = await Promise.all(manifest.files.map(async entry => {
    const response = await fetch(`${base}${entry.file}`);
    if (!response.ok) throw new Error(`Could not load course part ${entry.file}.`);
    return { entry, file: new File([await response.arrayBuffer()], entry.file, { type: 'application/octet-stream' }) };
  }));
  const previous = app.get().design;
  if (previous) await put('designs', previous);
  await importFiles(files.filter(f => f.entry.base).map(f => f.file), false);
  // Course conditions are independent of an existing design's vehicle-weight/solver settings.
  const design = app.get().design;
  if (!design) throw new Error('Could not create the course design.');
  app.set({ design: { ...design, settings: { ...DEFAULT_SETTINGS, engine: 'webgpu', quality: 'custom', custom_cells: 72, custom_passes: 10, detail_ratio: 1 } } });
  await importFiles(files.filter(f => !f.entry.base).map(f => f.file), true);
  renameCurrent('Aerodynamics course · teaching car');
  await renameGroup('g:body', 'Flat-floor body');
  for (const { entry } of files.filter(f => !f.entry.base)) {
    await renameGroup(entry.group, entry.name);
    await setGroupEnabled(entry.group, false);
  }
  await flushDesignSave();
  toast('Teaching car ready. Keep exactly one body active; use group switches for variants.');
}
