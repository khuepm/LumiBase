import { test, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { items } from '@lumibase/database';

function fieldExpression(name: string) {
  return sql`${items.data}->>${name}`;
}

test('sql injection query generation', () => {
  const expr = fieldExpression("a' OR '1'='1");
  const resultQuery = sql`SELECT * FROM table WHERE ${expr} = 'b'`;
  // We can convert the SQL object to a parametrized query to see what PG gets.
  // Using an inline trick for Drizzle ORM string generation:
  console.log(resultQuery.queryChunks);
});
