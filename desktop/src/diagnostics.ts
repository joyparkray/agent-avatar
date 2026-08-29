type DiagnosticTarget = Pick<Window, "addEventListener" | "removeEventListener">;
type DiagnosticConsole = Pick<Console, "error" | "warn">;

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: value.message || String(value), stack: value.stack };
  if (typeof value === "string") return { message: value };
  try { return { message: JSON.stringify(value) }; } catch { return { message: String(value) }; }
}

export function installGlobalDiagnostics(log: (event: object) => void, target: DiagnosticTarget = window, output: DiagnosticConsole = console, now: () => number = Date.now): () => void {
  const lastMessage = new Map<string, number>();
  const forward = (event: string, values: unknown[], explicitStack?: string) => {
    const details = values.map(describe), message = details.map(value => value.message).join(" ").slice(0, 1000), time = now();
    if (time - (lastMessage.get(message) ?? -Infinity) < 1000) return;
    lastMessage.set(message, time);
    const stack = explicitStack ?? details.find(value => value.stack)?.stack;
    log({ event, message, ...(stack ? { stack: stack.slice(0, 4000) } : {}) });
  };
  const originalError = output.error.bind(output), originalWarn = output.warn.bind(output);
  output.error = (...values: unknown[]) => { originalError(...values); forward("console:error", values); };
  output.warn = (...values: unknown[]) => { originalWarn(...values); forward("console:warn", values); };
  const onError = (event: Event) => { const error = event as ErrorEvent; forward("window:error", [error.message || error.error], error.error instanceof Error ? error.error.stack : undefined); };
  const onRejection = (event: Event) => { const rejection = event as PromiseRejectionEvent; const details = describe(rejection.reason); forward("window:unhandledrejection", [rejection.reason], details.stack); };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => { output.error = originalError; output.warn = originalWarn; target.removeEventListener("error", onError); target.removeEventListener("unhandledrejection", onRejection); };
}
