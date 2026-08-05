export const CART_CODEC_ERROR_CODES = [
  "E_CART_ARGUMENT",
  "E_CART_LIMITS",
  "E_CART_INPUT_TOO_LARGE",
  "E_CART_PNG_SIGNATURE",
  "E_CART_PNG_TRUNCATED",
  "E_CART_PNG_CHUNK_LIMIT",
  "E_CART_PNG_CHUNK_LENGTH",
  "E_CART_PNG_CRC",
  "E_CART_PNG_ORDER",
  "E_CART_PNG_CRITICAL_CHUNK",
  "E_CART_PNG_IHDR",
  "E_CART_PNG_DIMENSIONS",
  "E_CART_PNG_FORMAT",
  "E_CART_PNG_IDAT_LIMIT",
  "E_CART_PNG_ZLIB",
  "E_CART_PNG_DEFLATE",
  "E_CART_PNG_INFLATE_LIMIT",
  "E_CART_PNG_FILTER",
  "E_CART_PAYLOAD",
  "E_CART_FUTURE_VERSION",
  "E_CART_CODE_CORRUPT",
  "E_CART_CODE_TOO_LARGE",
] as const;

export type CartCodecErrorCode = (typeof CART_CODEC_ERROR_CODES)[number];

export type CartCodecErrorDetails = Readonly<
  Record<string, string | number | boolean>
>;

export class CartCodecError extends Error {
  override readonly name = "CartCodecError";
  readonly code: CartCodecErrorCode;
  readonly offset?: number;
  readonly details?: CartCodecErrorDetails;

  constructor(
    code: CartCodecErrorCode,
    message: string,
    options: { readonly offset?: number; readonly details?: CartCodecErrorDetails } = {},
  ) {
    super(message);
    this.code = code;
    if (options.offset !== undefined) this.offset = options.offset;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function codecFailure(
  code: CartCodecErrorCode,
  message: string,
  options: { readonly offset?: number; readonly details?: CartCodecErrorDetails } = {},
): never {
  throw new CartCodecError(code, message, options);
}
