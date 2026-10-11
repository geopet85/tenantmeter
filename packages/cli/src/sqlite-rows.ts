import type { SQLInputValue, StatementSync } from 'node:sqlite';

const owner = Symbol('sqlite statement owner');

// Node 22.13's native iterator does not retain its StatementSync wrapper. An
// async yield or output backpressure can let GC finalize an unfinished query.
// Give the iterator ownership of the wrapper for exactly the iterator lifetime.
export function sqliteRows(statement: StatementSync, ...parameters: SQLInputValue[]) {
  const iterator = statement.iterate(...parameters);
  Object.defineProperty(iterator, owner, {value: statement});
  return iterator;
}
