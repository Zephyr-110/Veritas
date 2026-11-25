declare module "better-sqlite3" {
  namespace Database {
    export interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    export interface Options {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
      verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
      nativeBinding?: string;
    }

    export interface PragmaOptions {
      simple?: boolean;
    }

    export interface Statement<
      BindParameters extends unknown[] | Record<string, unknown> = unknown[],
      Result = unknown,
    > {
      run(
        ...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]
      ): RunResult;
      get(
        ...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]
      ): Result | undefined;
      all(
        ...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]
      ): Result[];
      iterate(
        ...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]
      ): IterableIterator<Result>;
      pluck(toggleState?: boolean): this;
      raw(toggleState?: boolean): this;
    }

    export interface Transaction<F extends (...args: never[]) => unknown> {
      (...args: Parameters<F>): ReturnType<F>;
      default(...args: Parameters<F>): ReturnType<F>;
      deferred(...args: Parameters<F>): ReturnType<F>;
      immediate(...args: Parameters<F>): ReturnType<F>;
      exclusive(...args: Parameters<F>): ReturnType<F>;
    }

    export interface Database {
      readonly inTransaction: boolean;
      readonly open: boolean;
      readonly readonly: boolean;
      readonly name: string;
      prepare<
        BindParameters extends unknown[] | Record<string, unknown> = unknown[],
        Result = unknown,
      >(
        source: string
      ): Statement<BindParameters, Result>;
      transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>;
      exec(source: string): this;
      pragma(source: string, options?: PragmaOptions): unknown;
      close(): this;
    }
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Database.Options): Database.Database;
    (filename: string, options?: Database.Options): Database.Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
