const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  streamModel,
  readSse,
  chatMessages,
  endpointUrl,
} = require('./Protocol');
const config = {
  endpoint: 'http://localhost:8317/v1',
  protocol: 'responses',
  model: 'test',
};
const sse = events =>
  events
    .map(
      event =>
        'data: ' +
        (typeof event === 'string' ? event : JSON.stringify(event)) +
        '\r\n\r\n'
    )
    .join('');
const fakeFetch = events => async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(sse(events));
        for (let index = 0; index < bytes.length; index += 3)
          controller.enqueue(bytes.slice(index, index + 3));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  );

test('SSE decodes split UTF-8, CRLF frames, comments, and final frame', async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\ndata: héllo\r\ndata: world\r\n\r\ndata: tail'
  );
  const body = async function*() {
    for (const byte of bytes) yield new Uint8Array([byte]);
  };
  const result = [];
  for await (const frame of readSse(body())) result.push(frame);
  assert.deepEqual(result, ['héllo\nworld', 'tail']);
});
test('Responses assembles multiple calls and preserves encrypted reasoning verbatim', async () => {
  const reasoning = {
    id: 'rs_1',
    type: 'reasoning',
    encrypted_content: 'opaque',
    summary: [],
  };
  const output = [
    reasoning,
    {
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call1',
      name: 'inspect',
      arguments: '{"x":1}',
    },
    {
      id: 'fc_2',
      type: 'function_call',
      call_id: 'call2',
      name: 'edit',
      arguments: '{}',
    },
  ];
  const result = await streamModel({
    config,
    input: [],
    fetchImpl: fakeFetch([
      { type: 'response.output_item.added', output_index: 0, item: reasoning },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...output[1], arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        delta: '{"x":',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        delta: '1}',
      },
      { type: 'response.output_item.done', output_index: 1, item: output[1] },
      { type: 'response.completed', response: { output } },
      '[DONE]',
    ]),
  });
  assert.deepEqual(result.output, output);
  let body;
  await streamModel({
    config,
    input: result.output,
    fetchImpl: async (_url, request) => {
      body = JSON.parse(request.body);
      return new Response(JSON.stringify({ output: [], status: 'completed' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(body.input[0], reasoning);
  assert.equal(body.store, false);
  assert.equal(body.previous_response_id, undefined);
});
test('Chat Completions assembles indexed interleaved calls and text', async () => {
  const result = await streamModel({
    config: { ...config, protocol: 'chat-completions' },
    input: [],
    fetchImpl: fakeFetch([
      {
        choices: [
          {
            delta: {
              content: 'Inspecting',
              tool_calls: [
                {
                  index: 0,
                  id: 'a',
                  function: { name: 'inspect', arguments: '{' },
                },
                {
                  index: 1,
                  id: 'b',
                  function: { name: 'edit', arguments: '{"n":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: '2}' } },
                { index: 0, function: { arguments: '}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      '[DONE]',
    ]),
  });
  assert.equal(result.text, 'Inspecting');
  assert.equal(result.output[1].arguments, '{}');
  assert.equal(result.output[2].arguments, '{"n":2}');
  const messages = chatMessages([
    ...result.output,
    { type: 'function_call_output', call_id: 'a', output: 'OK' },
  ]);
  assert.equal(messages[0].tool_calls.length, 2);
  assert.equal(messages[1].tool_call_id, 'a');
});
test('disconnect and malformed frames never return executable tools', async () => {
  await assert.rejects(
    streamModel({
      config,
      input: [],
      fetchImpl: fakeFetch([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'a',
            name: 'edit',
            arguments: '{}',
          },
        },
      ]),
    }),
    /disconnected/
  );
  await assert.rejects(
    streamModel({ config, input: [], fetchImpl: fakeFetch(['{']) }),
    /Invalid JSON/
  );
  await assert.rejects(
    streamModel({
      config: { ...config, protocol: 'chat-completions' },
      input: [],
      fetchImpl: fakeFetch([{ choices: [{ finish_reason: 'length' }] }]),
    }),
    /before completing/
  );
});
test('authentication, rate limits, cancellation, and endpoint validation', async () => {
  for (const [status, code] of [[401, 'authentication'], [429, 'rate-limit']])
    await assert.rejects(
      streamModel({
        config,
        input: [],
        fetchImpl: async () =>
          new Response('{"error":{"message":"failure"}}', { status }),
      }),
      error => error.code === code
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    streamModel({
      config,
      input: [],
      signal: controller.signal,
      fetchImpl: fakeFetch([
        { type: 'response.completed', response: { output: [] } },
      ]),
    }),
    { name: 'AbortError' }
  );
  assert.equal(
    endpointUrl(config.endpoint + '/', 'models'),
    'http://localhost:8317/v1/models'
  );
  assert.throws(() => endpointUrl('file:///tmp/test', 'models'), /HTTP/);
});
