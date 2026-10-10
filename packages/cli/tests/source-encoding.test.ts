import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSource } from '../src/source.ts';
import type { Source } from '../src/model.ts';

test('SDK requests XML-safe listing keys and decodes URL encoding exactly once', async () => {
  const previous = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.AWS_ACCESS_KEY_ID = 'test'; process.env.AWS_SECRET_ACCESS_KEY = 'test';
  let source: Source | undefined;
  const keys = ['customers/a/new\nline', 'customers/東京/é', 'customers/a/%2F', 'customers/a/a+b', 'customers/a/100%'];
  let encoding = true;
  let malformed = false;
  try {
    source = await createSource({provider: 's3', bucket: 'test-bucket', region: 'us-east-1', prefix: '', pattern: 'customers/{tenant_id}/*'}, {
      requestHandler: { async handle(request: any) {
        assert.equal(request.query['encoding-type'], 'url');
        const returned = malformed ? ['customers/a/bad%ZZ'] : encoding ? keys.map(key => encodeURIComponent(key)) : ['customers/a/a+b%2F'];
        const body = `<ListBucketResult><IsTruncated>false</IsTruncated>${encoding ? '<EncodingType>url</EncodingType>' : ''}${returned.map(key => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;
        return {response: {statusCode: 200, headers: {'content-type': 'application/xml'}, body: Readable.from([body])}};
      } }
    });
    const signal = new AbortController().signal;
    assert.deepEqual((await source.page(null, 100, signal)).objects.map(row => row.key), keys);
    encoding = false;
    assert.deepEqual((await source.page(null, 100, signal)).objects.map(row => row.key), ['customers/a/a+b%2F']);
    encoding = true; malformed = true;
    await assert.rejects(source.page(null, 100, signal), /invalid URL-encoded object key/);
  } finally {
    source?.close();
    if (previous.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = previous.id;
    if (previous.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
  }
});
