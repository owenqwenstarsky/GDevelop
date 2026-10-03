// @flow
import {
  listAllPublicAssets,
  listAllResources,
} from '../../Utils/GDevelopServices/Asset';
import { listAllExamples } from '../../Utils/GDevelopServices/Example';
import documentation from './DocumentationIndex.json';

let assetsPromise: ?Promise<any>;
let resourcesPromise: ?Promise<any>;
const rank = (entries: Array<any>, query: any) => {
  const words = String(query || '')
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);
  return entries
    .map(entry => ({
      entry,
      score: words.reduce(
        (score, word) =>
          score +
          (JSON.stringify(entry)
            .toLowerCase()
            .includes(word)
            ? 1
            : 0),
        0
      ),
    }))
    .filter(result => !words.length || result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
};
export const searchLocalAssets = async (options: any): Promise<any> => {
  if (!assetsPromise)
    assetsPromise = listAllPublicAssets({ environment: 'live' }).catch(
      error => {
        assetsPromise = null;
        throw error;
      }
    );
  const data = await assetsPromise;
  const results = rank(
    data.publicAssetShortHeaders.filter(
      asset => !options.objectType || asset.objectType === options.objectType
    ),
    options.exactOrPartialAssetId || options.searchTerms || options.description
  );
  return {
    id: 'local-search',
    userId: 'local',
    createdAt: new Date().toISOString(),
    query: options,
    status: 'completed',
    results: results.map(({ entry, score }) => ({ score, asset: entry })),
  };
};
export const searchLocalResources = async (options: any): Promise<any> => {
  if (!resourcesPromise)
    resourcesPromise = listAllResources({ environment: 'live' }).catch(
      error => {
        resourcesPromise = null;
        throw error;
      }
    );
  const data = await resourcesPromise;
  const results = rank(
    [...data.resources, ...data.resourcesV2].filter(
      resource =>
        !options.resourceKind || resource.type === options.resourceKind
    ),
    options.searchTerms
  );
  return {
    id: 'local-search',
    userId: 'local',
    createdAt: new Date().toISOString(),
    query: options,
    status: 'completed',
    results: results.map(({ entry, score }) => ({ score, resource: entry })),
  };
};
export const runLocalTool = async (name: string, args: any): Promise<any> => {
  if (name === 'search_docs' || name === 'read_full_docs')
    return {
      success: true,
      attribution: documentation.attribution,
      sourceRevision: documentation.sourceRevision,
      results: rank(
        documentation.pages,
        args.query || args.extension_names
      ).map(result => ({
        ...result.entry,
        text: result.entry.text.slice(
          0,
          name === 'read_full_docs' ? 16000 : 4000
        ),
      })),
    };
  if (name === 'search_object_asset_store')
    return {
      success: true,
      ...(await searchLocalAssets({
        searchTerms: args.query,
        objectType: args.object_type,
      })),
    };
  if (name === 'search_resource_store')
    return {
      success: true,
      ...(await searchLocalResources({
        searchTerms: args.query,
        resourceKind: args.resource_kind,
      })),
    };
  if (name === 'get_game_starter_summary') {
    const examples = await listAllExamples();
    const example = examples.exampleShortHeaders.find(
      item => item.slug === args.template_slug
    );
    return example
      ? { success: true, template: example }
      : { success: false, message: 'Public template not found.' };
  }
  if (name === 'report_fulfilment_problem')
    return {
      success: true,
      message: 'Failure report recorded in this local conversation.',
      report: args,
    };
  return null;
};
