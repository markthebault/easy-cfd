import { OPENFOAM_ENABLED } from "./features";

/** Backend lease is optional offline; navigator.locks still coordinates this origin's tabs. */
export async function computeLease(
  signal: AbortSignal,
  onLost: () => void = () => {},
  useBackend = false,
): Promise<() => Promise<void>> {
  const owner = crypto.randomUUID();
  let unlock: (() => void) | undefined;
  if (navigator.locks)
    await new Promise<void>((resolve, reject) => {
      void navigator.locks
        .request(
          "easycfd-heavy-simulation",
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(
                new Error(
                  "Another browser tab is running a simulation. Stop it before starting this run.",
                ),
              );
              return;
            }
            await new Promise<void>((release) => {
              unlock = release;
              resolve();
            });
          },
        )
        .catch(reject);
    });
  let online = false;
  try {
    const response = useBackend && OPENFOAM_ENABLED ? await fetch("/api/compute-lease", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner }),
      signal,
    }) : null;
    if (response?.status === 409) {
      unlock?.();
      throw new Error(
        "Another local simulation is running. Stop it or wait before starting this run.",
      );
    }
    online = response?.ok ?? false;
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.message.startsWith("Another"))
    ) {
      unlock?.();
      throw error;
    }
  }
  let lastConfirmed = performance.now();
  const heartbeat = online
    ? setInterval(() => {
        void fetch("/api/compute-lease", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner }),
          signal: AbortSignal.timeout(4000),
        })
          .then((r) => {
            if (r.ok) lastConfirmed = performance.now();
            else onLost();
          })
          .catch(() => {
            if (performance.now() - lastConfirmed > 60000) onLost();
          });
      }, 2000)
    : undefined;
  return async () => {
    if (heartbeat) clearInterval(heartbeat);
    unlock?.();
    if (online)
      await fetch(`/api/compute-lease/${owner}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => undefined);
  };
}
