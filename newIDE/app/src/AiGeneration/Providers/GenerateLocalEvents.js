// @flow
import { invokeCustomAi } from './CustomAiBridge';
import {
  serializeToJSON,
  unserializeFromJSObject,
} from '../../Utils/Serializer';
import {
  resolveScope,
  getEventsFunctionInScope,
} from '../../EditorFunctions/Scope';
import {
  applyEventsChanges,
  addUndeclaredVariables,
  addObjectUndeclaredVariables,
  addMissingObjectBehaviors,
} from '../../EditorFunctions/ApplyEventsChanges';
import { scanProjectForValidationErrors } from '../../Utils/EventsValidationScanner';
import { enumerateAllInstructions } from '../../InstructionOrExpression/EnumerateInstructions';
import { makeTimestampedId } from '../../Utils/TimestampedId';
const gd: libGDevelop = global.gd;

const operations = new Set([
  'insert_at_end',
  'insert_before_event',
  'insert_after_event',
  'insert_as_sub_event',
  'insert_and_replace_event',
  'replace_entire_event_and_sub_events',
  'replace_event_but_keep_existing_sub_events',
  'delete_event',
]);
const errorKey = (error: any): string =>
  JSON.stringify([
    error.type,
    error.instructionType,
    error.parameterValue,
    error.locationName,
  ]);
const getEvents = (scope: any, functionName: ?string): gdEventsList => {
  if (scope.layout && !functionName) return scope.layout.getEvents();
  const target = getEventsFunctionInScope(scope, functionName);
  if (target.success === false) throw new Error(target.message);
  return target.eventsFunction.getEvents();
};

export const validateLocalEventChanges = (
  project: gdProject,
  options: any,
  changes: Array<any>
): void => {
  const copy = gd.ProjectHelper.createNewGDJSProject();
  try {
    unserializeFromJSObject(copy, JSON.parse(serializeToJSON(project)));
    const resolved = resolveScope(copy, options.scope);
    if (!resolved.success) throw new Error(resolved.message);
    const events = getEvents(resolved, options.functionName);
    const baseline: Map<string, number> = new Map();
    scanProjectForValidationErrors(copy).forEach(error => {
      const key = errorKey(error);
      baseline.set(key, (baseline.get(key) || 0) + 1);
    });
    for (const change of changes) {
      if (!operations.has(change.operationName))
        throw new Error('Unsupported event placement operation.');
      for (const extensionName of change.extensionNames)
        if (!copy.getCurrentPlatform().isExtensionLoaded(extensionName))
          throw new Error(
            `Missing extension dependency: ${extensionName}. Use installed instruction metadata or install the dependency first.`
          );
      addUndeclaredVariables({
        project: copy,
        resolvedScope: resolved,
        undeclaredVariables: change.undeclaredVariables,
      });
      for (const objectName of Object.keys(change.undeclaredObjectVariables))
        addObjectUndeclaredVariables({
          project: copy,
          resolvedScope: resolved,
          objectName,
          undeclaredVariables: change.undeclaredObjectVariables[objectName],
        });
      for (const objectName of Object.keys(change.missingObjectBehaviors))
        addMissingObjectBehaviors({
          project: copy,
          resolvedScope: resolved,
          objectName,
          missingBehaviors: change.missingObjectBehaviors[objectName],
        });
    }
    const applied = applyEventsChanges(
      copy,
      events,
      changes,
      'local-validation'
    );
    if (applied.errors.length || !applied.applied)
      throw new Error(
        applied.errors.join('\n') ||
          'No events were applied on the temporary project.'
      );
    const newErrors = scanProjectForValidationErrors(copy).filter(error => {
      const key = errorKey(error);
      const count = baseline.get(key) || 0;
      if (count) {
        baseline.set(key, count - 1);
        return false;
      }
      return true;
    });
    if (newErrors.length)
      throw new Error('Event validation errors: ' + JSON.stringify(newErrors));
  } finally {
    copy.delete();
  }
};

export const generateLocalEvents = async ({
  project,
  i18n,
  options,
  simplifiedProjectJson,
  projectSpecificExtensionsSummaryJson,
}: any): Promise<any> => {
  const id = 'custom-events-' + makeTimestampedId();
  const words = `${options.eventsDescription || ''} ${JSON.stringify(
    options.eventBatches || []
  )}`
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3);
  const metadata = [true, false].flatMap(isCondition =>
    enumerateAllInstructions(isCondition, project, i18n)
      .map(instruction => ({
        isCondition,
        type: instruction.type,
        description: instruction.description,
        parameters: Array.from(
          { length: instruction.metadata.getParametersCount() },
          (_, index) => {
            const parameter = instruction.metadata.getParameter(index);
            return {
              type: parameter.getType(),
              description: parameter.getDescription(),
              optional: parameter.isOptional(),
            };
          }
        ),
      }))
      .sort(
        (a, b) =>
          words.filter(word =>
            `${b.type} ${b.description}`.toLowerCase().includes(word)
          ).length -
          words.filter(word =>
            `${a.type} ${a.description}`.toLowerCase().includes(word)
          ).length
      )
      .slice(0, 180)
  );
  const instructions = `Translate the requested GDevelop events into native event JSON. Return only a JSON object with a changes array. Each change has operationName, operationTargetEvent (null for insert_at_end), generatedEvents (an array of serialized native events), extensionNames (array of installed dependencies), undeclaredVariables (array of {name,type,requiredScope}), undeclaredObjectVariables (object mapping object name to arrays), missingObjectBehaviors (object mapping object name to arrays of {name,type,objectName}), missingResources (array). Use only instruction types and parameter order from supplied metadata. Native event example: [{"type":"BuiltinCommonInstructions::Standard","conditions":[{"type":{"value":"KeyPressed"},"parameters":["","Space"]}],"actions":[],"events":[]}]. Preserve requested placement and replacement anchors. Supported operationName values: ${[
    ...operations,
  ].join(
    ', '
  )}. Do not invent variables or objects when existing ones can be used. Existing serialized events show exact serialization conventions. Return declarations for new variables.\nInstruction metadata: ${JSON.stringify(
    metadata
  )}`;
  const input = [
    {
      role: 'user',
      content: JSON.stringify({
        ...options,
        project: simplifiedProjectJson,
        extensions: projectSpecificExtensionsSummaryJson,
      }),
    },
  ];
  let diagnostics = '';
  // Initial attempt plus at most three repairs, always validated on a fresh copy.
  for (let attempt = 0; attempt <= 3; attempt++) {
    const result = await invokeCustomAi('specialist', {
      aiRequestId: options.relatedAiRequestId,
      instructions,
      input: [
        ...input,
        ...(diagnostics
          ? [
              {
                role: 'user',
                content: `Repair the previous proposal. Validation failed: ${diagnostics}`,
              },
            ]
          : []),
      ],
    });
    try {
      const response = JSON.parse(
        result.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
      );
      if (!Array.isArray(response.changes) || !response.changes.length)
        throw new Error('Expected a nonempty changes array.');
      const changes = response.changes.map(change => ({
        ...change,
        generatedEvents:
          typeof change.generatedEvents === 'string'
            ? change.generatedEvents
            : JSON.stringify(change.generatedEvents),
        isEventsJsonValid: true,
        areEventsValid: true,
        extensionNames: change.extensionNames || [],
        diagnosticLines: [],
        undeclaredVariables: change.undeclaredVariables || [],
        undeclaredObjectVariables: change.undeclaredObjectVariables || {},
        missingObjectBehaviors: change.missingObjectBehaviors || {},
        missingResources: change.missingResources || [],
      }));
      validateLocalEventChanges(project, options, changes);
      return {
        generationCompleted: true,
        aiGeneratedEvent: {
          id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: null,
          status: 'ready',
          partialGameProjectJson: simplifiedProjectJson,
          ...options,
          resultMessage: 'Validated locally on a temporary project.',
          changes,
          error: null,
          stats: null,
        },
      };
    } catch (error) {
      diagnostics = error.message;
      input.push({ role: 'assistant', content: result.text });
    }
  }
  return {
    generationCompleted: false,
    errorMessage:
      'Events failed local validation after three repair attempts: ' +
      diagnostics,
  };
};
