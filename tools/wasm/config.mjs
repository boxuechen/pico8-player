import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

export const SOURCE_DATE_EPOCH = "1731622349";
export const RUNTIME_ARTIFACT_BASENAME = "z8lua-runtime-v1";

export const RUNTIME_BRIDGE_SOURCES = [
  "wasm/bridge/p8w_pico_memory.cpp",
  "wasm/bridge/p8w_pico8_compat.cpp",
  "wasm/bridge/p8w_frame_runtime.cpp",
];

export const Z8LUA_SOURCES = [
  "lapi.c",
  "lcode.c",
  "ldebug.c",
  "ldo.c",
  "ldump.c",
  "lfunc.c",
  "lgc.c",
  "llex.c",
  "lmem.c",
  "lobject.c",
  "lopcodes.c",
  "lparser.c",
  "lstate.c",
  "lstring.c",
  "ltable.c",
  "ltm.c",
  "lundump.c",
  "lvm.c",
  "lzio.c",
  "lctype.c",
  "lauxlib.c",
  "lbaselib.c",
  "lcorolib.c",
  "ltablib.c",
  "lstrlib.c",
  "lpico8lib.c",
];

export const RUNTIME_EXPORTED_FUNCTIONS = [
  "_p8w_abi_version",
  "_p8w_create",
  "_p8w_destroy",
  "_p8w_bind_host",
  "_p8w_set_run_parameter",
  "_p8w_compile",
  "_p8w_boot",
  "_p8w_step",
  "_p8w_complete_host_request",
  "_p8w_log_snapshot",
  "_p8w_menu_snapshot",
  "_p8w_menu_invoke",
  "_p8w_menu_outcome",
  "_p8w_state",
  "_p8w_mode",
  "_p8w_target_fps",
  "_p8w_yield_reason",
  "_p8w_phase",
  "_p8w_consumed_instructions",
  "_p8w_lua_live_bytes",
  "_p8w_lua_heap_limit",
  "_p8w_live_contexts",
  "_p8w_pending_request_id",
  "_p8w_pending_request_ptr",
  "_p8w_pending_request_length",
  "_p8w_control_bytes_ptr",
  "_p8w_control_bytes_length",
  "_p8w_error_status",
  "_p8w_error_line",
  "_p8w_error_message_ptr",
  "_p8w_error_message_length",
  "_p8w_error_trace_ptr",
  "_p8w_error_trace_length",
  "_p8w_ram_ptr",
  "_p8w_ram_size",
  "_p8w_ram_reset",
  "_p8w_map_address",
  "_p8w_alloc",
  "_p8w_free",
];

export const RUNTIME_BUILD_FLAGS = [
  "-O2",
  "-std=c++17",
  "-x",
  "c++",
  "-fwasm-exceptions",
  "-fno-rtti",
  "-fno-ident",
  "-DP8W_BASELIB_SANDBOX=1",
  "--no-entry",
  "-sSTRICT=1",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createZ8LuaRuntimeV1Module",
  "-sENVIRONMENT=worker,node",
  "-sFILESYSTEM=0",
  "-sDYNAMIC_EXECUTION=0",
  "-sALLOW_MEMORY_GROWTH=0",
  "-sINITIAL_MEMORY=16777216",
  "-sSTACK_SIZE=262144",
  "-sMALLOC=emmalloc",
  "-sABORTING_MALLOC=0",
  "-sSUPPORT_LONGJMP=wasm",
  "-sASSERTIONS=0",
  "-sEXIT_RUNTIME=0",
  "-sINVOKE_RUN=0",
  `-sEXPORTED_FUNCTIONS=${RUNTIME_EXPORTED_FUNCTIONS.join(",")}`,
  "-sEXPORTED_RUNTIME_METHODS=HEAPU8,wasmMemory",
];

const EXPECTED_VERSION = "6.0.5";
const EXPECTED_VERSION_COMMIT = "1db513782be24469589d7cb8a1f1834e9a33f271";

async function isExecutable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && (await isExecutable(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolveEmxx(environment = process.env) {
  const executableName = process.platform === "win32" ? "em++.bat" : "em++";
  const pathCandidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, executableName));
  const emsdkCandidates = [
    environment.EMXX,
    environment.EMSDK
      ? join(environment.EMSDK, "upstream", "emscripten", executableName)
      : undefined,
    ...pathCandidates,
    join(
      homedir(),
      ".local",
      "share",
      "emsdk",
      "upstream",
      "emscripten",
      executableName,
    ),
  ];

  const emxx = await firstExisting(emsdkCandidates);
  if (!emxx) {
    throw new Error(
      "Pinned Emscripten not found. Set EMSDK/EMXX or put em++ on PATH; see wasm/README.md.",
    );
  }

  const result = spawnSync(emxx, ["--version"], {
    encoding: "utf8",
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to execute ${emxx}: ${result.stderr || result.stdout}`);
  }
  const firstLine = result.stdout.split(/\r?\n/u)[0] ?? "";
  if (
    !firstLine.includes(` ${EXPECTED_VERSION} `) ||
    !firstLine.includes(`(${EXPECTED_VERSION_COMMIT})`)
  ) {
    throw new Error(
      `Emscripten toolchain mismatch. Expected ${EXPECTED_VERSION} (${EXPECTED_VERSION_COMMIT}), got: ${firstLine}`,
    );
  }
  return { emxx, versionLine: firstLine };
}
