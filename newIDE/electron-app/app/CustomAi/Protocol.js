// Model transport lives in the main process. No remote response IDs are used.
const endpointUrl = (endpoint, route) => {
  const url = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTP(S) API base URL without credentials, query, or fragment.'
    );
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + route;
  return url.toString();
};

async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const lines = function*(final) {
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line) {
        if (data.length) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:'))
        data.push(line.slice(5).replace(/^ /, ''));
    }
    if (final) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
      if (data.length) yield data.join('\n');
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 16 * 1024 * 1024)
      throw new Error('Stream frame exceeds 16 MB.');
    yield* lines(false);
  }
  buffer += decoder.decode();
  yield* lines(true);
}

const httpError = async response => {
  let detail = '';
  try {
    const body = await response.json();
    detail = (body.error && body.error.message) || body.message || '';
  } catch (_) {}
  const error = new Error(
    `Model API returned HTTP ${response.status}${detail ? ': ' + detail : ''}`
  );
  error.code =
    response.status === 401 || response.status === 403
      ? 'authentication'
      : response.status === 429
      ? 'rate-limit'
      : 'http-error';
  return error;
};

const chatMessages = items => {
  const result = [];
  for (const item of items) {
    if (item.type === 'function_call') {
      const last = result[result.length - 1];
      const message =
        last && last.role === 'assistant'
          ? last
          : { role: 'assistant', content: null };
      if (message !== last) result.push(message);
      message.tool_calls = [
        ...(message.tool_calls || []),
        {
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        },
      ];
    } else if (item.type === 'function_call_output')
      result.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output,
      });
    else if (item.type === 'message' || item.role) {
      result.push({
        role: item.role,
        content:
          typeof item.content === 'string'
            ? item.content
            : (item.content || []).map(part =>
                part.type === 'input_image'
                  ? { type: 'image_url', image_url: { url: part.image_url } }
                  : { type: 'text', text: part.text || '' }
              ),
      });
    }
  }
  return result;
};

async function streamModel({
  config,
  key,
  input,
  instructions,
  tools = [],
  signal,
  onUpdate = () => {},
  fetchImpl = fetch,
}) {
  const responses = config.protocol === 'responses';
  const body = responses
    ? {
        model: config.model,
        input,
        instructions,
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        ...(tools.length
          ? {
              tools: tools.map(({ name, description, parameters }) => ({
                type: 'function',
                name,
                description,
                parameters,
                strict: false,
              })),
            }
          : {}),
        ...(config.reasoningEffort
          ? { reasoning: { effort: config.reasoningEffort } }
          : {}),
      }
    : {
        model: config.model,
        messages: [
          { role: 'system', content: instructions },
          ...chatMessages(input),
        ],
        stream: true,
        ...(tools.length
          ? {
              tools: tools.map(({ name, description, parameters }) => ({
                type: 'function',
                function: { name, description, parameters },
              })),
            }
          : {}),
        ...(config.reasoningEffort
          ? { reasoning_effort: config.reasoningEffort }
          : {}),
      };
  const response = await fetchImpl(
    endpointUrl(config.endpoint, responses ? 'responses' : 'chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
      },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    }
  );
  if (!response.ok) throw await httpError(response);
  const items = new Map();
  let text = '';
  let finished = false;
  let usage = null;
  const publish = () =>
    onUpdate({
      text,
      items: [...items.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(entry => entry[1]),
    });
  if (
    !(response.headers.get('content-type') || '').includes('text/event-stream')
  ) {
    const data = await response.json();
    if (responses) {
      if (
        data.error ||
        data.status === 'failed' ||
        data.status === 'incomplete'
      )
        throw new Error(
          (data.error && data.error.message) || 'Incomplete model response.'
        );
      (data.output || []).forEach((item, index) => items.set(index, item));
      text = (data.output || [])
        .filter(item => item.type === 'message')
        .flatMap(item => item.content || [])
        .filter(part => part.type === 'output_text')
        .map(part => part.text)
        .join('');
    } else {
      const choice = data.choices && data.choices[0];
      if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason))
        throw new Error('Incomplete model response.');
      text = choice.message.content || '';
      if (text)
        items.set(-1, {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      (choice.message.tool_calls || []).forEach((call, index) =>
        items.set(index, {
          type: 'function_call',
          call_id: call.id,
          ...call.function,
        })
      );
    }
    usage = data.usage;
    finished = true;
    publish();
  } else
    for await (const frame of readSse(response.body)) {
      if (signal && signal.aborted)
        throw new DOMException('Cancelled', 'AbortError');
      if (frame === '[DONE]') {
        if (!responses) finished = true;
        break;
      }
      let event;
      try {
        event = JSON.parse(frame);
      } catch (_) {
        throw new Error('Invalid JSON in model stream.');
      }
      if (
        event.error ||
        event.type === 'error' ||
        event.type === 'response.failed' ||
        event.type === 'response.incomplete'
      )
        throw new Error(
          (event.error && event.error.message) ||
            (event.response &&
              event.response.error &&
              event.response.error.message) ||
            event.message ||
            'Model response failed or incomplete.'
        );
      if (responses) {
        if (
          event.type === 'response.output_item.added' ||
          event.type === 'response.output_item.done'
        )
          items.set(event.output_index, event.item);
        if (event.type === 'response.output_text.delta') text += event.delta;
        if (event.type === 'response.function_call_arguments.delta') {
          const item = items.get(event.output_index);
          if (!item)
            throw new Error('Tool arguments arrived before tool identity.');
          items.set(event.output_index, {
            ...item,
            arguments: (item.arguments || '') + event.delta,
          });
        }
        if (event.type === 'response.completed') {
          if (event.response.output) {
            items.clear();
            event.response.output.forEach((item, index) =>
              items.set(index, item)
            );
          }
          usage = event.response.usage;
          finished = true;
        }
      } else {
        if (event.usage) usage = event.usage;
        const choice = event.choices && event.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        text += delta.content || '';
        if (text)
          items.set(-1, {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          });
        for (const call of delta.tool_calls || []) {
          const previous = items.get(call.index) || {
            type: 'function_call',
            call_id: '',
            name: '',
            arguments: '',
          };
          items.set(call.index, {
            ...previous,
            call_id: previous.call_id + (call.id || ''),
            name: previous.name + ((call.function && call.function.name) || ''),
            arguments:
              previous.arguments +
              ((call.function && call.function.arguments) || ''),
          });
        }
        if (choice.finish_reason) {
          if (!['stop', 'tool_calls'].includes(choice.finish_reason))
            throw new Error(
              'Model stopped before completing its response: ' +
                choice.finish_reason
            );
          finished = true;
        }
      }
      publish();
    }
  if (!finished)
    throw new Error(
      'Model stream disconnected before completion. Retry to continue; no tools were executed.'
    );
  const output = [...items.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(entry => entry[1]);
  for (const item of output)
    if (item.type === 'function_call' && (!item.call_id || !item.name))
      throw new Error('Model returned a tool call without its identity.');
  return { output, text, usage };
}

module.exports = { endpointUrl, readSse, streamModel, chatMessages, httpError };
