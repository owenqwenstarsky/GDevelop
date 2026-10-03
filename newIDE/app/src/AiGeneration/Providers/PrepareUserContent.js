// @flow
import { prepareAiUserContent as prepareHostedContent } from '../PrepareAiUserContent';
export const prepareProviderUserContent = (
  custom: boolean,
  options: any
): Promise<any> =>
  custom
    ? Promise.resolve({
        gameProjectJson: options.simplifiedProjectJson,
        gameProjectJsonUserRelativeKey: null,
        projectSpecificExtensionsSummaryJson:
          options.projectSpecificExtensionsSummaryJson,
        projectSpecificExtensionsSummaryJsonUserRelativeKey: null,
        eventsJson: options.eventsJson,
        eventsJsonUserRelativeKey: null,
      })
    : prepareHostedContent(options);
