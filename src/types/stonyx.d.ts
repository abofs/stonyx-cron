declare module 'stonyx/config' {
  const config: Record<string, unknown>;
  export default config;
}

declare module 'stonyx/log' {
  interface Log {
    error(message: string, ...args: unknown[]): void;
    cron(message: string): void;
    [key: string]: unknown;
  }
  const log: Log;
  export default log;
}
