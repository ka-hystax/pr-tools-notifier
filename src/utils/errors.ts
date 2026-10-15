// The code of a Node system error such as ENOENT or EEXIST, when the error carries one.
export function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}
