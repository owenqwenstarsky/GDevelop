// @flow
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../../EditorFunctions';
import schemas from './ToolSchemas.json';

export const getCustomToolDefinitions = (): Array<any> =>
  Object.keys(schemas)
    .filter(
      name => editorFunctions[name] || editorFunctionsWithoutProject[name]
    )
    .map(name => ({
      name,
      description: schemas[name].description,
      parameters: schemas[name].parameters,
      modifiesProject: !!(
        editorFunctions[name] || editorFunctionsWithoutProject[name]
      ).modifiesProject,
    }));
