// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import { type AiRequest } from '../../Utils/GDevelopServices/Generation';

const electron = optionalRequire('electron');
export const isCustomRequestId = (id: ?string): boolean =>
  !!id && id.startsWith('custom-');
export const isCustomRequest = (request: ?AiRequest): boolean =>
  !!request && request.provider === 'custom';
export const getCustomAiPreferences = (): any => {
  try {
    return (
      JSON.parse(localStorage.getItem('gd-preferences') || '{}').customAi || {
        provider: 'hosted',
        endpoint: '',
        protocol: 'responses',
        model: '',
        reasoningEffort: 'medium',
      }
    );
  } catch (_) {
    return { provider: 'hosted' };
  }
};
export const isCustomAiEnabled = (): boolean =>
  !!(electron && electron.ipcRenderer) &&
  getCustomAiPreferences().provider === 'custom';
export const invokeCustomAi = (
  operation: string,
  options: any = {}
): Promise<any> => {
  if (!electron || !electron.ipcRenderer)
    return Promise.reject(
      new Error('Custom AI is available in the desktop app.')
    );
  return electron.ipcRenderer.invoke('custom-ai:invoke', operation, options);
};
export const subscribeCustomAi = (
  callback: AiRequest => void
): (() => void) => {
  if (!electron || !electron.ipcRenderer) return () => {};
  const listener = (_event: any, request: AiRequest) => callback(request);
  electron.ipcRenderer.on('custom-ai:update', listener);
  return () =>
    electron.ipcRenderer.removeListener('custom-ai:update', listener);
};
