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
    error(message: string, ...args: unknown[]): void;
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
