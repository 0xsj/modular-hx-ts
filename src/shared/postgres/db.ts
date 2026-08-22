/**
 * `DB` — what a repository depends on. **L2 substrate.**
 *
 * Three methods, and **both a pool and a transaction satisfy it**. That dual
 * satisfaction is the whole point (`../../../MODULES.md` §3): it is what makes
 * `withinTx` transparent, so a repository method works identically inside a
 * transaction and outside one, and there is never a second set of methods for
 * the transactional case.
 *
 * **It names SQL and parameters, never a query builder.** This is where
 * query-layer swappability actually lives, and it only works if the type does
 * not mention the query layer: a repository that named `Kysely` in its
 * signature would have to change to swap it, which is precisely the test §3
 * gives for the interface being in the wrong place. A builder compiles *above*
 * this and hands down `{ sql, parameters }`.
 *
 * Declared here rather than by each consumer — §3 again: it is close enough to
 * universal to be treated like `io.Writer`, and a per-context copy of the same
 * three signatures is ceremony rather than inversion. **`Transactor` is the
 * opposite case and is deliberately not declared here**; see `tx.ts`.
 *
 * See `notes/patterns/postgres.md`.
 */

/** A row, before a repository gives it a type. */
export type Row = Readonly<Record<string, unknown>>;

export interface DB {
  /** Every matching row. */
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /**
   * The first row, or `undefined`.
   *
   * Not an error, and not a thrown `NotFound`: whether an absent row is a 404,
   * an empty option or a reason to insert is the caller's decision, and a
   * substrate that made it would be making a domain choice one layer too low.
   */
  queryRow<T = Row>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T | undefined>;

  /** Rows affected. */
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
}
