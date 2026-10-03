// @flow
import { validateLocalEventChanges } from './GenerateLocalEvents';
import { serializeToJSON } from '../../Utils/Serializer';
const gd: libGDevelop = global.gd;
const change = (events: any, overrides: any = {}) => ({
  operationName: 'insert_at_end',
  operationTargetEvent: null,
  generatedEvents: JSON.stringify(events),
  isEventsJsonValid: true,
  areEventsValid: true,
  extensionNames: [],
  diagnosticLines: [],
  undeclaredVariables: [],
  undeclaredObjectVariables: {},
  missingObjectBehaviors: {},
  missingResources: [],
  ...overrides,
});
describe('local event validation', () => {
  let project: gdProject;
  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
    project.insertNewLayout('Level', 0);
    project.insertNewLayout('Other', 1);
  });
  afterEach(() => project.delete());
  it('validates on a temporary copy without changing the live scene or other scenes', () => {
    const before = serializeToJSON(project);
    validateLocalEventChanges(
      project,
      { scope: { type: 'scene', scene_name: 'Level' }, functionName: null },
      [
        change([
          {
            type: 'BuiltinCommonInstructions::Standard',
            conditions: [],
            actions: [],
          },
        ]),
      ]
    );
    expect(serializeToJSON(project)).toBe(before);
  });
  it('rejects invalid instructions and missing dependencies before applying to the live project', () => {
    const before = serializeToJSON(project);
    expect(() =>
      validateLocalEventChanges(
        project,
        { scope: { type: 'scene', scene_name: 'Level' }, functionName: null },
        [
          change([
            {
              type: 'BuiltinCommonInstructions::Standard',
              conditions: [],
              actions: [
                { type: { value: 'DoesNotExist::Action' }, parameters: [] },
              ],
            },
          ]),
        ]
      )
    ).toThrow(/validation errors/);
    expect(() =>
      validateLocalEventChanges(
        project,
        { scope: { type: 'scene', scene_name: 'Level' }, functionName: null },
        [
          change(
            [
              {
                type: 'BuiltinCommonInstructions::Standard',
                conditions: [],
                actions: [],
              },
            ],
            { extensionNames: ['DoesNotExist'] }
          ),
        ]
      )
    ).toThrow(/Missing extension dependency/);
    expect(serializeToJSON(project)).toBe(before);
  });
  it('rejects missing scopes and stale placement paths', () => {
    expect(() =>
      validateLocalEventChanges(
        project,
        { scope: { type: 'scene', scene_name: 'Gone' }, functionName: null },
        []
      )
    ).toThrow(/not found/);
    expect(() =>
      validateLocalEventChanges(
        project,
        { scope: { type: 'scene', scene_name: 'Level' }, functionName: null },
        [
          change(
            [
              {
                type: 'BuiltinCommonInstructions::Standard',
                conditions: [],
                actions: [],
              },
            ],
            {
              operationName: 'replace_entire_event_and_sub_events',
              operationTargetEvent: 'event-99',
            }
          ),
        ]
      )
    ).toThrow();
  });
});
