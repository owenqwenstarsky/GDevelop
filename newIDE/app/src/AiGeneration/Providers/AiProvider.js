// @flow
import * as Hosted from '../../Utils/GDevelopServices/Generation';
import {
  getCustomAiPreferences,
  isCustomAiEnabled,
  isCustomRequestId,
  invokeCustomAi,
  subscribeCustomAi,
} from './CustomAiBridge';
import { getCustomToolDefinitions } from './ToolDefinitions';

// The same contract for both providers. Hosted retains its polling transport;
// the desktop provider publishes snapshots through the IPC subscription.
export type AiProvider = {|
  identity: 'hosted' | 'custom',
  subscribe: (callback: (Hosted.AiRequest) => void) => () => void,
  create: typeof Hosted.createAiRequest,
  continue: typeof Hosted.addMessageToAiRequest,
  get: typeof Hosted.getAiRequest,
  retry: typeof Hosted.retryAiRequest,
  suspend: typeof Hosted.suspendAiRequest,
  list: typeof Hosted.getAiRequestSummaries,
  update: typeof Hosted.updateAiRequest,
  delete: typeof Hosted.deleteAiRequest,
  branch: typeof Hosted.forkAiRequest,
|};
export const hostedProvider: AiProvider = {
  identity: 'hosted',
  subscribe: () => () => {},
  create: Hosted.createAiRequest,
  continue: Hosted.addMessageToAiRequest,
  get: Hosted.getAiRequest,
  retry: Hosted.retryAiRequest,
  suspend: Hosted.suspendAiRequest,
  list: Hosted.getAiRequestSummaries,
  update: Hosted.updateAiRequest,
  delete: Hosted.deleteAiRequest,
  branch: Hosted.forkAiRequest,
};
export const customProvider: AiProvider = {
  identity: 'custom',
  subscribe: subscribeCustomAi,
  create: (_auth, options) =>
    invokeCustomAi('create', {
      ...options,
      config: getCustomAiPreferences(),
      tools: getCustomToolDefinitions(),
    }),
  continue: (_auth, options) => invokeCustomAi('continue', options),
  get: (_auth, options) => invokeCustomAi('get', options),
  retry: (_auth, options) => invokeCustomAi('retry', options),
  suspend: (_auth, options) => invokeCustomAi('suspend', options),
  list: (_auth, options) => invokeCustomAi('list', options),
  update: (_auth, options) => invokeCustomAi('update', options),
  delete: (_auth, options) => invokeCustomAi('delete', options),
  branch: (_auth, options) =>
    invokeCustomAi('branch', {
      ...options,
      messageId: options.upToMessageId,
    }),
};
export const getAiProvider = (requestId?: ?string): AiProvider =>
  requestId
    ? isCustomRequestId(requestId)
      ? customProvider
      : hostedProvider
    : isCustomAiEnabled()
    ? customProvider
    : hostedProvider;

export const createAiRequest: typeof Hosted.createAiRequest = (auth, options) =>
  getAiProvider().create(auth, options);
export const addMessageToAiRequest: typeof Hosted.addMessageToAiRequest = (
  auth,
  options
) => getAiProvider(options.aiRequestId).continue(auth, options);
export const getAiRequest: typeof Hosted.getAiRequest = (auth, options) =>
  getAiProvider(options.aiRequestId).get(auth, options);
export const retryAiRequest: typeof Hosted.retryAiRequest = (auth, options) =>
  getAiProvider(options.aiRequestId).retry(auth, options);
export const suspendAiRequest: typeof Hosted.suspendAiRequest = (
  auth,
  options
) => getAiProvider(options.aiRequestId).suspend(auth, options);
export const updateAiRequest: typeof Hosted.updateAiRequest = (auth, options) =>
  getAiProvider(options.aiRequestId).update(auth, options);
export const deleteAiRequest: typeof Hosted.deleteAiRequest = (auth, options) =>
  getAiProvider(options.aiRequestId).delete(auth, options);
export const forkAiRequest: typeof Hosted.forkAiRequest = (auth, options) =>
  getAiProvider(options.aiRequestId).branch(auth, options);
export const getAiRequestSummaries: typeof Hosted.getAiRequestSummaries = async (
  auth,
  options
) => {
  const local = await (isCustomAiEnabled() || options.userId === 'local'
    ? customProvider.list(auth, options)
    : Promise.resolve({ aiRequestSummaries: [], nextPageUri: null }));
  if (options.userId === 'local' || isCustomAiEnabled()) return local;
  const hosted = await hostedProvider.list(auth, options);
  return {
    ...hosted,
    aiRequestSummaries: [
      ...hosted.aiRequestSummaries,
      ...local.aiRequestSummaries,
    ],
  };
};
