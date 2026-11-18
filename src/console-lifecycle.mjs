// A console instance is one-shot. Restart by creating a new instance so no
// request, timer, or persistence state is carried over from the old one.
export function createConsoleLifecycle(startRuntime, stopRuntime) {
  let starting, stopping, cleanup;
  const clean = () => cleanup ??= Promise.resolve().then(stopRuntime);

  return {
    start() {
      if (stopping) return Promise.reject(new Error("Console app has been stopped"));
      return starting ??= Promise.resolve().then(startRuntime).catch(async error => {
        await clean().catch(() => {});
        throw error;
      });
    },
    stop() {
      return stopping ??= starting
        ? starting.catch(() => {}).then(clean)
        : Promise.resolve();
    },
  };
}
