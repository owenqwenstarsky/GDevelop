// @flow
import QuickJsWorker from './QuickJs.worker';
import {
  type ExposedScriptFunction,
  type ScriptExecutionResult,
  type ScriptFunctionCallRecord,
} from './ScriptRunner';

export const executeIsolatedScript = ({
  jsCode,
  exposedFunctions,
  shouldStop,
}: {|
  jsCode: string,
  exposedFunctions: Array<ExposedScriptFunction>,
  shouldStop?: () => boolean,
|}): Promise<ScriptExecutionResult> =>
  new Promise(resolve => {
    // $FlowFixMe[incompatible-type] - worker-loader exports the worker constructor.
    const worker: Worker = new QuickJsWorker();
    const functionCallRecords: Array<ScriptFunctionCallRecord> = [];
    const consoleLogs: Array<string> = [];
    const newSceneNames: Array<string> = [];
    const newExternalLayoutNames: Array<string> = [];
    let pending = false;
    let finished = false;
    let deferredCompletion: ?{|
      success: boolean,
      value: any,
      error: ?string,
    |} = null;
    let lastCalledFunctionName = null;
    const complete = (success: boolean, value: any, error: ?string) => {
      if (finished) return;
      worker.terminate();
      if (pending) {
        deferredCompletion = { success, value, error };
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolve({
        success,
        returnValue: value,
        error: error
          ? { message: error, lineNumber: null, lastCalledFunctionName }
          : null,
        functionCallRecords,
        consoleLogs,
        newSceneNames,
        newExternalLayoutNames,
      });
    };
    const timeout = setTimeout(
      () =>
        complete(false, null, 'Script exceeded its 30 second execution limit.'),
      30000
    );
    worker.onerror = event =>
      complete(false, null, event.message || 'QuickJS worker failed.');
    worker.onmessage = async event => {
      const data: any = event.data;
      if (finished) return;
      if (data.type === 'done') {
        complete(data.success, data.value, data.error);
        return;
      }
      if (data.type === 'log') {
        if (consoleLogs.length < 100) consoleLogs.push(data.text);
        return;
      }
      if (data.type !== 'call') return;
      if (
        pending ||
        functionCallRecords.length >= 100 ||
        (shouldStop && shouldStop())
      ) {
        complete(
          false,
          null,
          'Script stopped; no new editor operations were started.'
        );
        return;
      }
      const exposed = exposedFunctions.find(fn => fn.name === data.name);
      if (!exposed) {
        complete(
          false,
          null,
          'Editor function is not in the capability allowlist.'
        );
        return;
      }
      pending = true;
      lastCalledFunctionName = data.name;
      let result;
      try {
        const args = JSON.parse(data.arguments);
        result = await exposed.launch(args);
        const { meta, ...output } = result;
        functionCallRecords.push({
          functionName: data.name,
          args,
          success: !!result.success,
          output,
          didModifyProject:
            (meta && meta.didModifyProject) ||
            (exposed.modifiesProject && result.success)
              ? true
              : undefined,
        });
        if (meta && meta.newSceneNames)
          newSceneNames.push(...meta.newSceneNames);
        if (meta && meta.newExternalLayoutNames)
          newExternalLayoutNames.push(...meta.newExternalLayoutNames);
      } catch (error) {
        result = { success: false, message: error.message };
        functionCallRecords.push({
          functionName: data.name,
          args: null,
          success: false,
          output: result,
        });
      }
      pending = false;
      if (deferredCompletion) {
        const completion = deferredCompletion;
        deferredCompletion = null;
        complete(completion.success, completion.value, completion.error);
      } else if (shouldStop && shouldStop())
        complete(
          false,
          null,
          'Script stopped after the applying operation completed.'
        );
      else worker.postMessage({ type: 'result', callId: data.callId, result });
    };
    worker.postMessage({
      type: 'start',
      code: jsCode,
      names: exposedFunctions.map(fn => fn.name),
    });
  });
