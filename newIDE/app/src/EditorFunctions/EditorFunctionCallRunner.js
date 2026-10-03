// @flow
import { invokeCustomAi } from '../AiGeneration/Providers/CustomAiBridge';
import { runLocalTool } from '../AiGeneration/Providers/LocalTools';
import { serializeToJSON } from '../Utils/Serializer';
import schemas from '../AiGeneration/Providers/ToolSchemas.json';
import { type I18n as I18nType } from '@lingui/core';
import { type EventsGenerationResult } from '.';
import {
  editorFunctions,
  editorFunctionsWithoutProject,
  type EditorFunction,
  type EditorFunctionWithoutProject,
  type EditorCallbacks,
  type EditorFunctionCall,
  type EditorFunctionCallResult,
  type EditorFunctionGenericOutput,
  type EventsGenerationOptions,
  type AssetSearchAndInstallOptions,
  type AssetSearchAndInstallResult,
  type EffectAssetSearchAndInstallOptions,
  type EffectAssetSearchAndInstallResult,
  type RelatedAiRequestLastMessages,
  type ResourceSearchAndInstallOptions,
  type ResourceSearchAndInstallResult,
  type ToolOptions,
} from '.';
import {
  type SceneEventsOutsideEditorChanges,
  type InstancesOutsideEditorChanges,
  type ObjectsOutsideEditorChanges,
  type ObjectGroupsOutsideEditorChanges,
  type ProjectItemRenamedOutsideEditorChanges,
  type WillDeleteSceneChanges,
  type WillDeleteGameplayTestChanges,
  type WillDeleteObjectChanges,
  type ExtensionsOutsideEditorChanges,
  type WillDeleteExtensionItemChanges,
} from './OutsideEditorChanges';
import PixiResourcesLoader from '../ObjectsRendering/PixiResourcesLoader';
import { type EnsureExtensionInstalledOptions } from '../AiGeneration/UseEnsureExtensionInstalled';
import { normalizeLegacyArguments } from './Scope';
import { type AttachmentsForResources } from './AttachmentResources';

type ProcessEditorFunctionCallsOptions = {|
  project: ?gdProject,
  functionCalls: Array<EditorFunctionCall>,
  i18n: I18nType,
  editorCallbacks: EditorCallbacks,
  toolOptions: ToolOptions | null,
  // The AI request's tools version (e.g. 'v12'), threaded to the functions so
  // they can gate version-dependent behavior (e.g. isNoOpConsideredSuccess).
  toolsVersion?: ?string,
  // When true, a `run_script` call is exposed only non-mutating functions
  // (explorer sub-agent scripts, which must stay read-only).
  runScriptReadOnly?: boolean,
  customProvider?: boolean,
  +customRole?: string,
  customAllowedFunctionNames?: Array<string>,
  shouldStop?: () => boolean,
  relatedAiRequestId: string | null,
  getRelatedAiRequestLastMessages: () => RelatedAiRequestLastMessages,
  generateEvents: (
    options: EventsGenerationOptions
  ) => Promise<EventsGenerationResult>,
  onSceneEventsModifiedOutsideEditor: (
    changes: SceneEventsOutsideEditorChanges
  ) => void,
  onInstancesModifiedOutsideEditor: (
    changes: InstancesOutsideEditorChanges
  ) => void,
  onObjectsModifiedOutsideEditor: (
    changes: ObjectsOutsideEditorChanges
  ) => void,
  onEffectsModifiedOutsideEditor: () => void,
  onObjectGroupsModifiedOutsideEditor: (
    changes: ObjectGroupsOutsideEditorChanges
  ) => void,
  onProjectItemRenamedOutsideEditor: (
    changes: ProjectItemRenamedOutsideEditorChanges
  ) => void,
  onWillDeleteScene: (changes: WillDeleteSceneChanges) => Promise<void>,
  onWillDeleteGameplayTest: (
    changes: WillDeleteGameplayTestChanges
  ) => Promise<void>,
  onWillDeleteObject: (changes: WillDeleteObjectChanges) => void,
  onExtensionsModifiedOutsideEditor: (
    changes: ExtensionsOutsideEditorChanges
  ) => void,
  ensureExtensionsUpToDate: () => Promise<void>,
  reloadExtensionMetadata: (extensionName: string) => void,
  onWillDeleteExtensionItem: (
    changes: WillDeleteExtensionItemChanges
  ) => Promise<void>,
  ensureExtensionInstalled: (
    options: EnsureExtensionInstalledOptions
  ) => Promise<void>,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
  searchAndInstallAsset: (
    options: AssetSearchAndInstallOptions
  ) => Promise<AssetSearchAndInstallResult>,
  searchAndInstallEffectAsset: (
    options: EffectAssetSearchAndInstallOptions
  ) => Promise<EffectAssetSearchAndInstallResult>,
  searchAndInstallResources: (
    options: ResourceSearchAndInstallOptions
  ) => Promise<ResourceSearchAndInstallResult>,
  attachmentsForResources: AttachmentsForResources,
  getAssetStoreTagForNewObject: (objectType: string) => string | null,
|};

const processCalls = async ({
  functionCalls,
  project,
  i18n,
  editorCallbacks,
  toolOptions,
  toolsVersion,
  runScriptReadOnly,
  customProvider,
  customRole,
  shouldStop,
  generateEvents,
  onSceneEventsModifiedOutsideEditor,
  onInstancesModifiedOutsideEditor,
  onObjectsModifiedOutsideEditor,
  onEffectsModifiedOutsideEditor,
  onObjectGroupsModifiedOutsideEditor,
  onProjectItemRenamedOutsideEditor,
  onWillDeleteScene,
  onWillDeleteGameplayTest,
  onWillDeleteObject,
  onExtensionsModifiedOutsideEditor,
  ensureExtensionsUpToDate,
  reloadExtensionMetadata,
  onWillDeleteExtensionItem,
  relatedAiRequestId,
  getRelatedAiRequestLastMessages,
  ensureExtensionInstalled,
  onWillInstallExtension,
  onExtensionInstalled,
  searchAndInstallAsset,
  searchAndInstallEffectAsset,
  searchAndInstallResources,
  attachmentsForResources,
  getAssetStoreTagForNewObject,
}: ProcessEditorFunctionCallsOptions): Promise<{|
  results: Array<EditorFunctionCallResult>,
  createdSceneNames: Array<string>,
  createdExternalLayoutNames: Array<string>,
  createdProject: ?gdProject,
|}> => {
  const results: Array<EditorFunctionCallResult> = [];
  const createdSceneNames: Array<string> = [];
  const createdExternalLayoutNames: Array<string> = [];
  let createdProject: ?gdProject = null;

  for (const functionCall of functionCalls) {
    const call_id = functionCall.call_id;
    const name = functionCall.name;
    if (!project && !editorFunctionsWithoutProject[name]) {
      results.push({
        status: 'finished',
        call_id,
        success: false,
        output: {
          message: 'No project opened.',
        },
      });
      continue;
    }
    if (project && name === 'initialize_project') {
      results.push({
        status: 'finished',
        call_id,
        success: false,
        output: {
          message:
            'A project is already open — initialize_project cannot be called. If starting from a new project is the right approach, suggest the user close the current project and start a new AI request.',
        },
      });
      continue;
    }
    let args;
    try {
      try {
        args = JSON.parse(functionCall.arguments);
      } catch (error) {
        console.error('Error parsing arguments: ', error);
        results.push({
          status: 'finished',
          call_id,
          success: false,
          output: {
            message: 'Invalid arguments (not a valid JSON string).',
          },
        });
        // Without this, the function would still run with `args: undefined`
        // and a second result would be pushed for the same call_id.
        continue;
      }

      // $FlowFixMe[invalid-compare]
      if (name === null) {
        results.push({
          status: 'finished',
          call_id,
          success: false,
          output: {
            message: 'Missing or invalid function name.',
          },
        });
        continue;
      }

      // $FlowFixMe[invalid-compare]
      if (args === null) {
        results.push({
          status: 'finished',
          call_id,
          success: false,
          output: {
            message: `Invalid arguments for function: ${name}.`,
          },
        });
        continue;
      }

      // Legacy argument names (e.g. `scene_name`) are mapped to their current
      // form once here, so the functions implement one version of the tools.
      args = normalizeLegacyArguments(args);

      // Check if the function exists
      const editorFunction: EditorFunction | null =
        editorFunctions[name] || null;
      const editorFunctionWithoutProject: EditorFunctionWithoutProject | null =
        editorFunctionsWithoutProject[name] || null;
      if (!editorFunction && !editorFunctionWithoutProject) {
        results.push({
          status: 'finished',
          call_id,
          success: false,
          output: {
            message: `Unknown function: ${name}.`,
          },
        });
        continue;
      }

      const argumentsWithoutProject = {
        args,
        i18n,
        toolOptions,
        toolsVersion,
        runScriptReadOnly,
        customProvider,
        customAllowedFunctionNames: customProvider
          ? Object.keys(schemas).filter(functionName => {
              const definition =
                editorFunctions[functionName] ||
                editorFunctionsWithoutProject[functionName];
              return (
                definition &&
                (customRole !== 'explorer' || !definition.modifiesProject) &&
                (customRole !== 'tester' ||
                  !definition.modifiesProject ||
                  functionName === 'change_gameplay_tests')
              );
            })
          : undefined,
        shouldStop,
        editorCallbacks,
        relatedAiRequestId,
        getRelatedAiRequestLastMessages,
        generateEvents,
        onSceneEventsModifiedOutsideEditor,
        onInstancesModifiedOutsideEditor,
        onObjectsModifiedOutsideEditor,
        onEffectsModifiedOutsideEditor,
        onObjectGroupsModifiedOutsideEditor,
        onProjectItemRenamedOutsideEditor,
        onWillDeleteScene,
        onWillDeleteGameplayTest,
        onWillDeleteObject,
        onExtensionsModifiedOutsideEditor,
        ensureExtensionsUpToDate,
        reloadExtensionMetadata,
        onWillDeleteExtensionItem,
        ensureExtensionInstalled,
        onWillInstallExtension,
        onExtensionInstalled,
        searchAndInstallAsset,
        searchAndInstallEffectAsset,
        searchAndInstallResources: (options: ResourceSearchAndInstallOptions) =>
          searchAndInstallResources({ ...options, relatedAiRequestId }),
        attachmentsForResources,
        getAssetStoreTagForNewObject,
        PixiResourcesLoader,
      };

      // Execute the function
      let result: EditorFunctionGenericOutput;
      const localResult = customProvider
        ? await runLocalTool(name, args)
        : null;
      if (localResult) {
        result = localResult;
      } else if (editorFunction) {
        if (project) {
          result = await editorFunction.launchFunction({
            ...argumentsWithoutProject,
            project,
          });
        } else {
          result = ({
            success: false,
            message: `Function ${name} requires a project to be opened before being used.`,
          }: EditorFunctionGenericOutput);
        }
      } else if (editorFunctionWithoutProject) {
        result = await editorFunctionWithoutProject.launchFunction(
          argumentsWithoutProject
        );
      } else {
        result = ({
          success: false,
          message: `Unknown function with name: ${name}. Please use something else as this seems not supported or existing.`,
        }: EditorFunctionGenericOutput);
      }

      if (result.aborted) {
        results.push({ status: 'aborted', call_id });
        continue;
      }

      const { success, meta, ...output } = result;
      const editorFunctionDef = editorFunction || editorFunctionWithoutProject;
      // `run_script` sets `meta.didModifyProject` explicitly: a script can
      // apply project-changing calls before failing, so its "did modify" is
      // NOT `modifiesProject && success` — honor the reported value when given.
      const didModifyProject =
        meta && typeof meta.didModifyProject === 'boolean'
          ? meta.didModifyProject || undefined
          : editorFunctionDef && editorFunctionDef.modifiesProject && success
          ? true
          : undefined;
      results.push({
        status: 'finished',
        call_id,
        success,
        output,
        didModifyProject,
      });

      if (meta && meta.newSceneNames) {
        createdSceneNames.push(...meta.newSceneNames);
      }
      if (meta && meta.newExternalLayoutNames) {
        createdExternalLayoutNames.push(...meta.newExternalLayoutNames);
      }
      if (meta && meta.createdProject) {
        createdProject = meta.createdProject;
      }
    } catch (error) {
      results.push({
        status: 'finished',
        call_id,
        success: false,
        output: { message: error.message || 'Unknown error' },
      });
    }
  }

  return {
    results,
    createdSceneNames,
    createdExternalLayoutNames,
    createdProject,
  };
};

// One queue for each live project, shared across all custom conversations/hooks.
// The main-process journal also guards against duplicate execution after restart.
const projectQueues: WeakMap<Object, Promise<any>> = new WeakMap();
const noProjectQueueKey = {};
export const processEditorFunctionCalls = (
  options: ProcessEditorFunctionCallsOptions
): Promise<any> => {
  if (!options.customProvider) return processCalls(options);
  const key = options.project || noProjectQueueKey;
  const previous = projectQueues.get(key) || Promise.resolve();
  const queued = previous
    .catch(() => {})
    .then(async () => {
      const aggregate: {|
        results: Array<EditorFunctionCallResult>,
        createdSceneNames: Array<string>,
        createdExternalLayoutNames: Array<string>,
        createdProject: ?gdProject,
      |} = {
        results: [],
        createdSceneNames: [],
        createdExternalLayoutNames: [],
        createdProject: null,
      };
      for (const call of options.functionCalls) {
        if (options.shouldStop && options.shouldStop()) break;
        const project = aggregate.createdProject || options.project;
        const requestId = options.relatedAiRequestId;
        const definition =
          editorFunctions[call.name] ||
          editorFunctionsWithoutProject[call.name];
        const allowed =
          schemas[call.name] &&
          definition &&
          (options.customRole !== 'explorer' ||
            !definition.modifiesProject ||
            call.name === 'run_script') &&
          (options.customRole !== 'tester' ||
            !definition.modifiesProject ||
            ['run_gameplay_test', 'change_gameplay_tests'].includes(call.name));
        if (!allowed) {
          aggregate.results.push({
            status: 'finished',
            call_id: call.call_id,
            success: false,
            output: {
              message: 'Tool is not allowed for this custom agent role.',
            },
          });
          continue;
        }
        const before =
          project && definition.modifiesProject
            ? serializeToJSON(project)
            : null;
        await invokeCustomAi('begin-tool', {
          aiRequestId: requestId,
          callId: call.call_id,
          projectJson: before,
        });
        const processed = await processCalls({
          ...options,
          project,
          functionCalls: [call],
        });
        const resultingProject = processed.createdProject || project;
        const after =
          resultingProject && definition.modifiesProject
            ? serializeToJSON(resultingProject)
            : null;
        const result = processed.results[0];
        if (result && result.status === 'finished') {
          if (before !== after) result.didModifyProject = true;
          await invokeCustomAi('finish-tool', {
            aiRequestId: requestId,
            callId: call.call_id,
            result,
            projectJson: after,
            gameId: resultingProject ? resultingProject.getProjectUuid() : null,
          });
        }
        aggregate.results.push(...processed.results);
        aggregate.createdSceneNames.push(...processed.createdSceneNames);
        aggregate.createdExternalLayoutNames.push(
          ...processed.createdExternalLayoutNames
        );
        if (processed.createdProject)
          aggregate.createdProject = processed.createdProject;
      }
      return aggregate;
    });
  projectQueues.set(key, queued);
  return queued;
};
