import type { SessionCommand, SessionControlCommand, SessionInputCommand, SessionEvent } from "./session-contract.js";
export * from "./session-contract.js";
type Wire<T> = T extends unknown ? T & { readonly v: 1; readonly workerGeneration: number } : never;
export type PlayerRuntimeControlCommand = Wire<SessionControlCommand>;
export type PlayerRuntimeInputCommand = Wire<SessionInputCommand>;
export type PlayerHostToRuntime = Wire<SessionCommand>;
export type PlayerRuntimeToHost = Wire<SessionEvent>;
