import type { TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export function installSelectionInput(tui: TUI, handler: TerminalInputHandler): () => void {
  // Older pi versions consume mouse events before extension input listeners.
  // Keep this compatibility bridge isolated until pi exposes listener priority.
  const listeners = (tui as unknown as { inputListeners?: Set<TerminalInputHandler> }).inputListeners;
  if (!(listeners instanceof Set)) throw new Error("This pi version does not support the bridge mouse adapter");
  const previous = [...listeners];
  listeners.clear();
  listeners.add(handler);
  for (const listener of previous) listeners.add(listener);
  return () => { listeners.delete(handler); };
}
