declare module "sql.js" {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export interface Statement {
    bind(params?: any[] | Record<string, any>): boolean;
    step(): boolean;
    get(): any[] | undefined;
    getAsObject(): Record<string, any>;
    free(): boolean;
    run(values?: any[] | Record<string, any>): void;
  }

  export class Database {
    constructor(data?: ArrayBuffer | Uint8Array);
    run(sql: string, params?: any[] | Record<string, any>): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  export default function initSqlJs(
    config?: Partial<{ locateFile: (file: string) => string }>,
  ): Promise<SqlJsStatic>;
}
