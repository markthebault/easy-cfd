// Top bar, camera view buttons, toasts and the drag-and-drop overlay.

import { useEffect, useRef, useState } from "react";
import { CircleHelp, FolderOpen, Monitor, Moon, Plus, Replace, Sun } from "lucide-react";
import { useStore } from "../store/store";
import { app, importFiles, renameCurrent, setTheme, type ThemePref } from "../store/app";
import type { ViewName } from "../viz/helpers";
import { stages } from "./StageView";

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7cc4ff" />
          <stop offset="1" stopColor="#2a78d6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#logo-g)" />
      <path d="M6 12.5c5-3 9 3 14 0s4.5-2 6-2M6 17c5-3 9 3 14 0s4.5-2 6-2M6 21.5c5-3 9 3 14 0" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const THEMES: { value: ThemePref; icon: typeof Sun; label: string }[] = [
  { value: "system", icon: Monitor, label: "System theme" },
  { value: "dark", icon: Moon, label: "Dark theme" },
  { value: "light", icon: Sun, label: "Light theme" },
];

export function TopBar() {
  const design = useStore(app, (s) => s.design);
  const theme = useStore(app, (s) => s.theme);
  const view = useStore(app, (s) => s.view);
  const run = useStore(app, (s) => s.run);
  const [name, setName] = useState(design?.name ?? "");
  useEffect(() => setName(design?.name ?? ""), [design?.name]);
  const next = THEMES[(THEMES.findIndex((t) => t.value === theme) + 1) % THEMES.length];
  const Current = THEMES.find((t) => t.value === theme)!.icon;
  const title = view === "results" && run ? null : design;
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <span className="brand-name">EasyCFD</span>
        <span className="brand-tag">wind tunnel</span>
      </div>
      {title && view === "setup" && (
        <input
          className="design-name"
          value={name}
          aria-label="Design name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameCurrent(name)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      )}
      <div className="spacer" />
      <button className="btn ghost sm" onClick={() => app.set({ library: true })} data-testid="open-library">
        <FolderOpen size={16} /> <span className="hide-sm">Designs &amp; runs</span>
      </button>
      <button className="icon-btn" aria-label="Help" title="Help" onClick={() => app.set({ help: "guide" })}>
        <CircleHelp size={18} />
      </button>
      <button className="icon-btn" aria-label={`${THEMES.find((t) => t.value === theme)!.label}. Switch to ${next.label.toLowerCase()}`} title={`Theme: ${theme}`} onClick={() => setTheme(next.value)}>
        <Current size={18} />
      </button>
    </header>
  );
}

const VIEWS: { v: ViewName; label: string }[] = [
  { v: "front", label: "Front" },
  { v: "side", label: "Side" },
  { v: "top", label: "Top" },
  { v: "iso", label: "3D" },
];

export function ViewBar({ ids = ["main"] }: { ids?: string[] }) {
  return (
    <div className="view-bar glass" role="toolbar" aria-label="Camera views">
      {VIEWS.map(({ v, label }) => (
        <button key={v} onClick={() => ids.forEach((id) => stages[id]?.setView(v))} title={`${label} view`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore(app, (s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

/** Whole-page drop target. With a design open, the user chooses replace or add. */
export function DropOverlay() {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const hasDesign = useStore(app, (s) => !!s.design && s.design.source.kind === "files");
  const busy = useStore(app, (s) => s.view === "live");
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!isFiles(e) || busy) return;
      e.preventDefault();
      depth.current++;
      setActive(true);
    };
    const over = (e: DragEvent) => isFiles(e) && e.preventDefault();
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setActive(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      // Drops on the explicit targets are handled there.
      if ((e.target as HTMLElement)?.closest?.("[data-drop]")) return;
      if (!busy && e.dataTransfer?.files.length) importFiles([...e.dataTransfer.files], false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [busy]);
  if (!active) return null;
  const target = (add: boolean) => ({
    "data-drop": add ? "add" : "replace",
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      importFiles([...e.dataTransfer.files], add);
    },
  });
  return (
    <div className="drop-overlay">
      {hasDesign ? (
        <div className="drop-targets">
          <div className="drop-target" {...target(false)}><Replace size={28} /><b>Replace the car</b><span>Start a new design</span></div>
          <div className="drop-target" {...target(true)}><Plus size={28} /><b>Add parts</b><span>Same coordinates as the car</span></div>
        </div>
      ) : (
        <div className="drop-target single" {...target(false)}><Plus size={30} /><b>Drop to import</b><span>STL, OBJ, GLB or glTF</span></div>
      )}
    </div>
  );
}
