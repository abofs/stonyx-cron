declare module 'stonyx/config' {
  interface CronConfig {
    log?: boolean;
  }
  interface Config {
    cron?: CronConfig;
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
    [key: string]: unknown;
  }
  const log: Log;
  export default log;
}
