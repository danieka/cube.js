import { PostgresDriver, PostgresDriverConfiguration } from '@cubejs-backend/postgres-driver';
import { BaseDriver, DownloadTableMemoryData, IndexesSQL, StreamOptions, StreamTableDataWithTypes, TableStructure } from '@cubejs-backend/query-orchestrator';
import { PoolClient, QueryResult } from 'pg';
import { Readable } from 'stream';

export type ReadableStreamTableDataWithTypes = StreamTableDataWithTypes & {
  /**
   * Compatibility with streamToArray method from '@cubejs-backend/shared'
   */
  rowStream: Readable;
};

export class MaterializeDriver extends PostgresDriver {
  public constructor(options: PostgresDriverConfiguration) {
    super(options);
  }

  protected async prepareConnection(
    conn: PoolClient
  ) {
    await conn.query(`SET TIME ZONE '${this.config.storeTimezone || 'UTC'}'`);
    // Support for statement_timeout is still pending. https://github.com/MaterializeInc/materialize/issues/10390
  }

  protected async loadUserDefinedTypes(): Promise<void> {
    // Support for typcategory field still pending: https://github.com/MaterializeInc/materialize/issues/2157
  }

  /**
   * @param {string} schemaName
   * @return {Promise<Array<unknown>>}
   */
  public async createSchemaIfNotExists(schemaName: string): Promise<unknown[]> {
    const schemas = await this.query(
      `SHOW SCHEMAS WHERE name = '${schemaName}'`, []
    );
    if (schemas.length === 0) {
      this.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`, []);
    }
    return [];
  }

  public async uploadTableWithIndexes(
    table: string,
    columns: TableStructure,
    tableData: DownloadTableMemoryData,
    indexesSql: IndexesSQL
  ) {
    return BaseDriver.prototype.uploadTableWithIndexes.bind(this)(table, columns, tableData, indexesSql, [], null);
  }

  protected async* asyncFetcher<R extends unknown>(conn: PoolClient, cursorId: string): AsyncGenerator<R> {
    const timeout = `${this.config.executionTimeout ? <number>(this.config.executionTimeout) * 1000 : 600000} milliseconds`;
    const queryParams = {
      text: `FETCH 1000 ${cursorId} WITH (TIMEOUT='${timeout}');`,
      values: [],
      types: { getTypeParser: this.getTypeParser }
    };
    let finish = false;

    while (!finish) {
      const results: QueryResult<any> | undefined = await conn.query(queryParams);
      const { rows, rowCount } = results;

      if (rowCount === 0) {
        finish = true;
      }

      for (const row of rows) {
        yield row;
      }
    }
  }

  public async stream(
    query: string,
    values: unknown[],
    { highWaterMark }: StreamOptions
  ): Promise<ReadableStreamTableDataWithTypes> {
    const conn = await this.pool.connect();
    try {
      const cursorId = 'mz_cursor';
      await this.prepareConnection(conn);
      await conn.query('BEGIN;', []);
      await conn.query(`DECLARE ${cursorId} CURSOR FOR ${query}`, values);
      const { fields } = await conn.query({
        text: `FETCH 0 FROM ${cursorId};`,
        values: [],
        types: {
          getTypeParser: this.getTypeParser,
        },
      });
      const rowStream = Readable.from(this.asyncFetcher(conn, cursorId), { highWaterMark });

      return {
        rowStream,
        types: this.mapFields(fields),
        release: async () => {
          await conn.release();
        }
      };
    } catch (e) {
      await conn.release();

      throw e;
    }
  }
}