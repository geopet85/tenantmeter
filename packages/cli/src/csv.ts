// Streaming CSV reader for local metadata exports. No rows are loaded in bulk.
export async function* csvRows(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string[]> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let skipLF = false;
  let first = true;
  let started = false;
  let length = 0;
  function finishField() {
    row.push(field);
    if (row.length > 256) throw new Error('CSV contains more than 256 columns.');
    field = '';
    afterQuote = false;
  }
  async function* consume(text: string) {
    for (const char of text) {
      if (first) { first = false; if (char === '\uFEFF') continue; }
      if (skipLF) { skipLF = false; if (char === '\n') continue; }
      if (++length > 1_048_576) throw new Error('CSV record exceeds 1048576 characters.');
      if (quoted) {
        if (char === '"') { quoted = false; afterQuote = true; }
        else field += char;
        continue;
      }
      if (afterQuote && char === '"') { quoted = true; afterQuote = false; field += '"'; continue; }
      if (afterQuote && ![',', '\r', '\n'].includes(char)) throw new Error('CSV has characters after a closing quote.');
      if (char === ',') { finishField(); started = true; }
      else if (char === '\r' || char === '\n') {
        finishField();
        if (started || row.length > 1 || row[0] !== '') yield row;
        row = []; started = false; length = 0;
        if (char === '\r') skipLF = true;
      } else if (char === '"') {
        if (field.length) throw new Error('CSV quote inside an unquoted field.');
        quoted = true; started = true;
      } else { field += char; started = true; }
    }
  }
  for await (const chunk of input) yield* consume(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
  yield* consume(decoder.decode());
  if (quoted) throw new Error('CSV ends inside a quoted field.');
  if (started || row.length || field.length || afterQuote) { finishField(); yield row; }
}

export function columns(value: string | string[]) {
  const names = (typeof value === 'string' ? value.split(',') : value).map(x => x.trim());
  if (!names.length || names.some(x => !x) || new Set(names).size !== names.length) throw new Error('CSV column names must be nonempty and unique.');
  return names;
}

export function decimalBytes(value: unknown, label = 'bytes') {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a nonnegative decimal integer string.`);
  return value;
}
