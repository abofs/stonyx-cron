declare module 'stonyx/config' {
  interface CronConfig {
    log?: boolean;
    logColor?: string;
    logMethod?: string;
  }
  interface Config {
    cron: CronConfig;
    debug?: boolean;
    [key: string]: unknown;
  }
  const config: Config;
  export default config;
}

declare module 'stonyx/log' {
  interface Log {
    // `@stonyx/logs` materialises these from `defaultOptions.systemLogs` via
    // `createConvenienceMethod`, so they exist at runtime but are declared
    // upstream only through a `[key: string]: unknown` index signature — which
    // resolves to a non-callable `unknown`. Hence the shim. The signature below
    // is the real one: argument 2 is `logToFile`, NOT a format argument, and the
    // return is a promise that can reject when the log volume is unwritable.
    error(content: string, logToFile?: boolean, overwrite?: boolean): Promise<void>;
    warn(content: string, logToFile?: boolean, overwrite?: boolean): Promise<void>;
    cron(message: string): void;
    defineType(type: string, setting: string, options?: Record<string, unknown> | null): void;
    [key: string]: unknown;
  }
  const log: Log;
  export default log;
}

declare module 'stonyx/test-helpers' {
  interface Hooks {
    before(fn: () => void | Promise<void>): void;
    beforeEach(fn: () => void | Promise<void>): void;
    afterEach(fn: () => void | Promise<void>): void;
    after(fn: () => void | Promise<void>): void;
  }
  export function setupIntegrationTests(hooks: Hooks): void;
}
