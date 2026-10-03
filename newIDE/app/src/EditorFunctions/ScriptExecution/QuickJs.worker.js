// Isolated QuickJS VM: model code never runs in the browser JavaScript realm.
/* eslint-disable no-restricted-globals */
import { getQuickJS } from 'quickjs-emscripten';

let context;
let runtime;
let result;
let completed = false;
const promises = new Map();
let callCount = 0;
const fail = message => {
  if (!completed) {
    completed = true;
    self.postMessage({ type: 'done', success: false, error: message });
  }
};
const pump = () => {
  if (completed) return;
  const executed = runtime.executePendingJobs();
  if (executed.error) {
    const error = context.dump(executed.error);
    executed.error.dispose();
    fail(error.message || String(error));
    return;
  }
  const state = context.getPromiseState(result);
  if (state.type === 'fulfilled') {
    completed = true;
    self.postMessage({
      type: 'done',
      success: true,
      value: context.dump(state.value),
    });
    state.value.dispose();
  } else if (state.type === 'rejected') {
    const error = context.dump(state.error);
    state.error.dispose();
    fail(error.message || String(error));
  }
};
self.onmessage = async event => {
  try {
    if (event.data.type === 'start') {
      const QuickJS = await getQuickJS();
      runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(32 * 1024 * 1024);
      runtime.setMaxStackSize(1024 * 1024);
      const deadline = Date.now() + 30000;
      runtime.setInterruptHandler(() => Date.now() > deadline);
      context = runtime.newContext();
      const bridge = context.newFunction('__editorCall', (name, args) => {
        if (promises.size)
          return context.throw(
            context.newError(
              'Await each editor call; concurrent calls are forbidden.'
            )
          );
        if (++callCount > 100)
          return context.throw(
            context.newError('Script exceeded 100 editor calls.')
          );
        const callId = callCount;
        const deferred = context.newPromise();
        promises.set(callId, deferred);
        self.postMessage({
          type: 'call',
          callId,
          name: context.getString(name),
          arguments: context.getString(args),
        });
        return deferred.handle;
      });
      context.setProp(context.global, '__editorCall', bridge);
      bridge.dispose();
      const logger = context.newFunction('__log', value => {
        self.postMessage({
          type: 'log',
          text: context.getString(value).slice(0, 4000),
        });
      });
      context.setProp(context.global, '__log', logger);
      logger.dispose();
      const functions = event.data.names
        .map(
          name =>
            `const ${name} = async args => { const r = JSON.parse(await __editorCall(${JSON.stringify(
              name
            )}, JSON.stringify(args))); if (!r.success) throw new Error(r.message || 'Editor function failed'); return r; };`
        )
        .join('\n');
      const evaluated = context.evalCode(
        `(async () => {\n${functions}\nconst console = { log: (...values) => __log(values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ')) };\n${
          event.data.code
        }\n})()`,
        'custom-agent.js'
      );
      if (evaluated.error) {
        const error = context.dump(evaluated.error);
        evaluated.error.dispose();
        fail(error.message || String(error));
        return;
      }
      result = evaluated.value;
      pump();
    } else if (event.data.type === 'result' && !completed) {
      const deferred = promises.get(event.data.callId);
      if (!deferred) return;
      promises.delete(event.data.callId);
      const value = context.newString(JSON.stringify(event.data.result));
      deferred.resolve(value);
      value.dispose();
      deferred.dispose();
      pump();
    }
  } catch (error) {
    fail(error.message);
  }
};
