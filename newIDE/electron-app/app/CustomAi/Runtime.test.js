const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CustomAiRuntime, pendingCalls } = require('./Runtime');
const config = {
  endpoint: 'http://localhost:8317/v1',
  protocol: 'responses',
  model: 'test',
  reasoningEffort: 'medium',
};
const call = (name, call_id = 'call1', args = {}) => ({
  type: 'function_call',
  name,
  call_id,
  arguments: JSON.stringify(args),
});
const text = value => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: value }],
});
const tool = (name, modifiesProject = false) => ({
  name,
  modifiesProject,
  description: name,
  parameters: { type: 'object', properties: {} },
});
const settle = async (runtime, requestId) => {
  for (let i = 0; i < 100; i++) {
    if (!runtime.running.has(requestId)) return runtime.get(requestId);
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Runtime did not settle.');
};
const fixture = (t, responses = []) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gdevelop-custom-ai-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bodies = [];
  const runtime = new CustomAiRuntime({
    root,
    safeStorage: { isEncryptionAvailable: () => false },
    fetchImpl: async (url, options) => {
      assert.ok(url.startsWith(config.endpoint));
      bodies.push(JSON.parse(options.body));
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: responses.shift() || [text('Done')],
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    },
  });
  return { root, runtime, bodies };
};
test('logged-out conversations persist native reasoning and continue after restart with provider pinned', async t => {
  const reasoning = {
    type: 'reasoning',
    id: 'rs_1',
    encrypted_content: 'opaque',
    summary: [],
  };
  const { runtime, root, bodies } = fixture(t, [
    [reasoning, text('Hello')],
    [text('Again')],
  ]);
  const request = await runtime.create({
    config,
    userRequest: 'Hi',
    tools: [],
  });
  await settle(runtime, request.id);
  await runtime.continue({ aiRequestId: request.id, userMessage: 'Continue' });
  await settle(runtime, request.id);
  assert.deepEqual(bodies[1].input[1], reasoning);
  const restarted = new CustomAiRuntime({
    root,
    fetchImpl: () => {
      throw new Error('Must not make a request on restart');
    },
  });
  const restored = restarted.get(request.id);
  assert.equal(restored.status, 'ready');
  assert.equal(restored.provider, 'custom');
  assert.deepEqual(restored.customConfiguration, {
    ...config,
    credentialReference: null,
  });
});
test('session-only keys never reach disk, and encrypted credentials contain no plaintext', t => {
  const { runtime, root } = fixture(t);
  const result = runtime.setKey(config.endpoint, 'test-key');
  assert.equal(result.sessionOnly, true);
  assert.equal(
    runtime.key({ ...config, credentialReference: result.credentialReference }),
    'test-key'
  );
  assert.equal(fs.readdirSync(path.join(root, 'credentials')).length, 0);
  runtime.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value =>
      Buffer.from(
        'cipher:' +
          value
            .split('')
            .reverse()
            .join('')
      ),
    decryptString: buffer =>
      buffer
        .toString()
        .slice(7)
        .split('')
        .reverse()
        .join(''),
  };
  const saved = runtime.setKey(config.endpoint, 'test-key');
  assert.equal(saved.sessionOnly, false);
  assert.ok(
    !fs
      .readFileSync(runtime.credentials.file(saved.credentialReference), 'utf8')
      .includes('test-key')
  );
});
test('interrupted execution is suspended, never replayed, and resume requires inspection', async t => {
  const { runtime, root } = fixture(t, [[call('edit')]]);
  const request = await runtime.create({
    config,
    userRequest: 'Edit',
    tools: [tool('edit', true)],
  });
  await settle(runtime, request.id);
  await runtime.begin({
    aiRequestId: request.id,
    callId: 'call1',
    projectJson: '{"before":true}',
  });
  const restarted = new CustomAiRuntime({
    root,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ status: 'completed', output: [text('Inspect first')] })
      ),
  });
  assert.equal(restarted.get(request.id).status, 'suspended');
  assert.equal(restarted.get(request.id).executions[0].status, 'uncertain');
  await assert.rejects(
    restarted.begin({ aiRequestId: request.id, callId: 'call1' }),
    /stopped/
  );
  restarted.retry(request.id);
  await settle(restarted, request.id);
  assert.equal(pendingCalls(restarted.get(request.id)).length, 0);
  assert.match(
    restarted
      .get(request.id)
      .output.find(message => message.type === 'function_call_output').output,
    /uncertain/
  );
});
test('stop allows applying result to finish without starting another model call', async t => {
  const { runtime, bodies } = fixture(t, [[call('edit')]]);
  const request = await runtime.create({
    config,
    userRequest: 'Edit',
    tools: [tool('edit', true)],
  });
  await settle(runtime, request.id);
  await runtime.begin({
    aiRequestId: request.id,
    callId: 'call1',
    projectJson: '{}',
  });
  runtime.suspend(request.id);
  runtime.finish({
    aiRequestId: request.id,
    callId: 'call1',
    result: { success: true, output: { message: 'Applied' } },
    projectJson: '{"changed":true}',
  });
  await runtime.continue({ aiRequestId: request.id, functionCallOutputs: [] });
  assert.equal(bodies.length, 1);
  assert.equal(runtime.get(request.id).executions[0].status, 'finished');
  assert.equal(runtime.get(request.id).checkpoints.length, 2);
});
test('main-process project lease serializes calls from separate conversations', async t => {
  const { runtime } = fixture(t, [[call('edit', 'a')], [call('edit', 'b')]]);
  const a = await runtime.create({
    config,
    gameId: 'project',
    userRequest: 'A',
    tools: [tool('edit', true)],
  });
  await settle(runtime, a.id);
  const b = await runtime.create({
    config,
    gameId: 'project',
    userRequest: 'B',
    tools: [tool('edit', true)],
  });
  await settle(runtime, b.id);
  await runtime.begin({ aiRequestId: a.id, callId: 'a' });
  let entered = false;
  const waiting = runtime.begin({ aiRequestId: b.id, callId: 'b' }).then(() => {
    entered = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, false);
  runtime.finish({
    aiRequestId: a.id,
    callId: 'a',
    result: { success: true, output: {} },
  });
  await waiting;
  assert.equal(entered, true);
  runtime.finish({
    aiRequestId: b.id,
    callId: 'b',
    result: { success: true, output: {} },
  });
});
test('malformed arguments and unsupported capabilities become structured tool failures', async t => {
  const { runtime } = fixture(t, [
    [{ ...call('edit'), arguments: '{' }, call('unsupported', 'b')],
    [text('Corrected')],
  ]);
  const request = await runtime.create({
    config,
    userRequest: 'Edit',
    tools: [tool('edit', true)],
  });
  await settle(runtime, request.id);
  const outputs = runtime
    .get(request.id)
    .output.filter(message => message.type === 'function_call_output');
  assert.equal(outputs.length, 2);
  assert.match(outputs[0].output, /Malformed/);
  assert.match(outputs[1].output, /not available/);
});
test('delegation returns child result once and explorers receive no mutation capabilities', async t => {
  const { runtime, bodies } = fixture(t, [
    [call('run_explorer_agent', 'delegate', { prompt: 'Inspect' })],
    [text('Explored')],
    [text('Complete')],
  ]);
  const request = await runtime.create({
    config,
    userRequest: 'Explore',
    tools: [tool('run_explorer_agent'), tool('edit', true), tool('inspect')],
  });
  await settle(runtime, request.id);
  const child = [...runtime.requests.values()].find(
    item => item.parentAiRequestId === request.id
  );
  assert.ok(child);
  assert.equal(child.role, 'explorer');
  assert.deepEqual(bodies[1].tools.map(item => item.name), ['inspect']);
  assert.equal(
    runtime
      .get(request.id)
      .output.filter(
        message =>
          message.type === 'function_call_output' &&
          message.call_id === 'delegate'
      ).length,
    1
  );
});
test('checkpoint restore first preserves current structure and suspends affected agents', async t => {
  const { runtime } = fixture(t, [[call('edit')]]);
  const request = await runtime.create({
    config,
    gameId: 'project',
    userRequest: 'Edit',
    tools: [tool('edit', true)],
  });
  await settle(runtime, request.id);
  await runtime.begin({
    aiRequestId: request.id,
    callId: 'call1',
    projectJson: '{"before":1}',
  });
  runtime.finish({
    aiRequestId: request.id,
    callId: 'call1',
    result: { success: true, output: {} },
    projectJson: '{"after":1}',
  });
  const checkpointId = runtime.get(request.id).checkpoints[0].id;
  const restored = runtime.checkpoint({
    aiRequestId: request.id,
    checkpointId,
    currentProjectJson: '{"current":1}',
  });
  assert.equal(restored, '{"before":1}');
  assert.equal(runtime.get(request.id).status, 'suspended');
  assert.equal(
    runtime.get(request.id).checkpoints[2].projectJson,
    '{"current":1}'
  );
});
test('branching, archive, rename and local image/text attachments survive reopening', async t => {
  const { runtime, root } = fixture(t, [[text('Reply')]]);
  const attachmentId = runtime.attachment({
    name: 'test.json',
    mimeType: 'application/json',
    bytes: [...Buffer.from('{"value":1}')],
  });
  const request = await runtime.create({
    config,
    userRequest: 'Read',
    attachmentIds: [attachmentId],
    tools: [],
  });
  await settle(runtime, request.id);
  const branch = runtime.branch({
    aiRequestId: request.id,
    messageId: runtime.get(request.id).output[1].messageId,
  });
  assert.equal(branch.status, 'suspended');
  assert.equal(branch.forkedFromAiRequestId, request.id);
  runtime.update({ aiRequestId: request.id, title: 'Named', archived: true });
  const restarted = new CustomAiRuntime({ root });
  assert.equal(restarted.get(request.id).title, 'Named');
  assert.ok(restarted.get(request.id).archivedAt);
  assert.equal(restarted.attachments.read(attachmentId).readableAs, 'text');
  assert.throws(
    () =>
      runtime.attachment({
        name: 'video.mp4',
        mimeType: 'video/mp4',
        bytes: [1],
      }),
    /Only images/
  );
});
