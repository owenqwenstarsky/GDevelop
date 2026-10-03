// @flow
import {
  createAiRequest,
  addMessageToAiRequest,
  getAiRequest,
  getAiRequestSummaries,
  hostedProvider,
} from './AiProvider';
import {
  isCustomAiEnabled,
  getCustomAiPreferences,
  invokeCustomAi,
} from './CustomAiBridge';
import * as Generation from '../../Utils/GDevelopServices/Generation';
jest.mock('./CustomAiBridge', () => ({
  isCustomAiEnabled: jest.fn(),
  getCustomAiPreferences: jest.fn(),
  invokeCustomAi: jest.fn(),
  isCustomRequestId: id => !!id && id.startsWith('custom-'),
  subscribeCustomAi: jest.fn(),
}));
jest.mock('./ToolDefinitions', () => ({ getCustomToolDefinitions: () => [] }));
jest.mock('../../Utils/GDevelopServices/Generation', () =>
  jest.genMockFromModule('../../Utils/GDevelopServices/Generation')
);
const auth = jest.fn<[], Promise<string>>();
const options: any = {
  userId: 'local',
  userRequest: 'Hello',
  aiRequestId: 'custom-one',
  userMessage: 'Continue',
};
describe('AI provider isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isCustomAiEnabled: any).mockReturnValue(true);
    (getCustomAiPreferences: any).mockReturnValue({
      endpoint: 'http://localhost/v1',
      protocol: 'responses',
      model: 'local-model',
    });
    (invokeCustomAi: any).mockResolvedValue({ id: 'custom-one' });
  });
  it('creates and continues a logged-out custom request without hosted APIs or uploads', async () => {
    await createAiRequest(auth, options);
    await addMessageToAiRequest(auth, options);
    expect((invokeCustomAi: any).mock.calls.map(call => call[0])).toEqual([
      'create',
      'continue',
    ]);
    expect(Generation.createAiRequest).not.toHaveBeenCalled();
    expect(Generation.addMessageToAiRequest).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });
  it('pins an existing conversation to its provider after changing preferences', async () => {
    (isCustomAiEnabled: any).mockReturnValue(false);
    await getAiRequest(auth, options);
    expect(invokeCustomAi).toHaveBeenCalledWith('get', options);
    (isCustomAiEnabled: any).mockReturnValue(true);
    const hostedOptions = { ...options, aiRequestId: 'hosted-one' };
    await getAiRequest(auth, hostedOptions);
    expect(Generation.getAiRequest).toHaveBeenCalledWith(auth, hostedOptions);
  });
  it('custom history never contacts Generation API even when signed in', async () => {
    (invokeCustomAi: any).mockResolvedValue({
      aiRequestSummaries: [],
      nextPageUri: null,
    });
    await getAiRequestSummaries(auth, {
      userId: 'account',
      filter: 'all',
      forceUri: null,
    });
    expect(Generation.getAiRequestSummaries).not.toHaveBeenCalled();
    expect(invokeCustomAi).toHaveBeenCalled();
  });
  it('retains the existing hosted lifecycle implementation', () => {
    expect(hostedProvider.create).toBe(Generation.createAiRequest);
    expect(hostedProvider.continue).toBe(Generation.addMessageToAiRequest);
  });
});
