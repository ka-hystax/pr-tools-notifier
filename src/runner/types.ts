import type { Snapshot } from "../contract/snapshot.js";
import type { OutMessage } from "../format/format.js";

export type Command = Snapshot["command"];

export type SnapshotSource = (command: Command) => Promise<Snapshot>;

export interface Sink {
  deliver(messages: OutMessage[]): Promise<void>;
  alert(html: string): Promise<void>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TickResult {
  ok: boolean;
  errors: string[];
  events: number;
  messages: number;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
