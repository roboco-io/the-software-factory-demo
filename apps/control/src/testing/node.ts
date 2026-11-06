// Test-only access to Node built-ins without @types/node.
export function nodeModule<T>(name: string): T {
  const proc = (
    globalThis as unknown as {
      process: { getBuiltinModule(n: string): unknown };
    }
  ).process;
  return proc.getBuiltinModule(name) as T;
}
