import type { Pico8Session, Pico8SessionObservation } from "./standalone-session.js";

/** Platform-neutral tool schema; adapters supply their own registration and image encoding. */
export const PICO8_SESSION_TOOL = {
  name: "pico8_session",
  description: "Load PICO-8 Lua, advance exact frames with held buttons, observe, reset or dispose a session.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["load_source", "advance", "observe", "reset", "dispose"] },
      source: { type: "string", description: "PICO-8 Lua source for load_source; resources use the session loadCart API." },
      frames: { type: "integer", minimum: 1, maximum: 600 },
      buttons: { type: "integer", minimum: 0, maximum: 63, description: "Player 1 held bitmask: left=1, right=2, up=4, down=8, O=16, X=32. Default releases all buttons." },
      image: { type: "boolean", description: "Include base64 RGBA8 pixels; defaults to true." },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

function base64(bytes: Uint8ClampedArray): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return btoa(text);
}
function serialize(observation: Pico8SessionObservation, image: boolean) {
  const frame = observation.frame;
  return { ...observation, frame: frame === null ? null : {
    frameId: frame.frameId, targetFps: frame.targetFps, cpuInstructions: frame.cpuInstructions,
    slowFrame: frame.slowFrame, width: frame.width, height: frame.height,
    ...(image ? { encoding: "rgba8-base64" as const, data: base64(frame.rgba) } : {}),
  } };
}

/** A thin JSON tool adapter: callers register this with their preferred agent host. */
export function createPico8SessionTool(session: Pico8Session) {
  return {
    ...PICO8_SESSION_TOOL,
    async execute(value: unknown) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("tool arguments must be an object");
      const args = value as Record<string, unknown>;
      if (Object.keys(args).some(key => !["action", "source", "frames", "buttons", "image"].includes(key))) {
        throw new TypeError("unknown tool argument");
      }
      if (args.image !== undefined && typeof args.image !== "boolean") throw new TypeError("image must be boolean");
      const image = args.image !== false;
      if (args.action === "load_source") {
        if (typeof args.source !== "string") throw new TypeError("source is required");
        return { observation: serialize(await session.loadSource(args.source), image) };
      }
      if (args.action === "advance") {
        const buttons = args.buttons ?? 0;
        if (!Number.isInteger(buttons) || Number(buttons) < 0 || Number(buttons) > 63) throw new RangeError("buttons must be 0–63");
        if (typeof args.frames !== "number") throw new TypeError("frames is required");
        const result = await session.advance({ frames: args.frames, input: {
          controllers: [Number(buttons), 0,0,0,0,0,0,0],
          devkit: { mouseXRaw: 0, mouseYRaw: 0, mouseButtons: 0, wheelRaw: 0, movementXRaw: 0, movementYRaw: 0, keypresses: [] },
        } });
        return { ...result, observation: serialize(result.observation, image) };
      }
      if (args.action === "reset") return { observation: serialize(await session.reset(), image) };
      if (args.action === "observe") return { observation: serialize(session.observe(), image) };
      if (args.action === "dispose") {
        await session.dispose();
        return { observation: serialize(session.observe(), image) };
      }
      throw new TypeError("unknown tool action");
    },
  };
}
