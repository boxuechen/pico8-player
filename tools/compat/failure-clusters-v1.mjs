export function failureClusterForFault(code) {
  if (code === "E_CART_PARSE" || code === "E_CART_FORMAT") return "parse";
  if (code === "E_VM_INSTRUCTION_BUDGET" || code === "E_VM_WATCHDOG") return "timing";
  if (code === "E_FEATURE_UNSUPPORTED" || code === "E_HOST_REQUEST") {
    return "unsupported-host-feature";
  }
  if (code === "E_FRAME_MISSING") return "graphics";
  return "language";
}
