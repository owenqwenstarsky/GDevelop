// @flow
import * as React from 'react';
import { TextField, MenuItem } from '@material-ui/core';
import { Trans } from '@lingui/macro';
import PreferencesContext from '../../MainFrame/Preferences/PreferencesContext';
import { ColumnStackLayout, LineStackLayout } from '../../UI/Layout';
import FlatButton from '../../UI/FlatButton';
import Text from '../../UI/Text';
import { invokeCustomAi } from './CustomAiBridge';

const defaults = {
  provider: 'hosted',
  endpoint: '',
  protocol: 'responses',
  model: '',
  reasoningEffort: 'medium',
};
export default function CustomAiSettings(): React.Node {
  const { values, setMultipleValues } = React.useContext(PreferencesContext);
  const config = { ...defaults, ...values.customAi };
  const [key, setKey] = React.useState('');
  const [models, setModels] = React.useState<Array<string>>([]);
  const [status, setStatus] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const update = (patch: any) =>
    setMultipleValues({ customAi: { ...config, ...patch } });
  const run = async (operation: () => Promise<string>) => {
    setBusy(true);
    setStatus('');
    try {
      const result = await operation();
      setStatus(result);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ColumnStackLayout>
      <TextField
        select
        label="AI provider"
        value={config.provider}
        onChange={event => update({ provider: event.target.value })}
      >
        <MenuItem value="hosted">GDevelop hosted</MenuItem>
        <MenuItem value="custom">Custom API (desktop)</MenuItem>
      </TextField>
      {config.provider === 'custom' && (
        <React.Fragment>
          <Text>
            <Trans>
              Connect to your externally managed CLIProxyAPI instance.
              Conversations and keys stay on this computer. No GDevelop account
              or credits are required.
            </Trans>
          </Text>
          <TextField
            label="API base URL"
            placeholder="http://localhost:8317/v1"
            value={config.endpoint}
            onChange={event =>
              update({
                endpoint: event.target.value,
                credentialReference: null,
              })
            }
          />
          <TextField
            select
            label="Protocol"
            value={config.protocol}
            onChange={event => update({ protocol: event.target.value })}
          >
            <MenuItem value="responses">Responses</MenuItem>
            <MenuItem value="chat-completions">Chat Completions</MenuItem>
          </TextField>
          <TextField
            label="Model (manual entry allowed)"
            value={config.model}
            onChange={event => update({ model: event.target.value })}
            inputProps={{ list: 'custom-ai-models' }}
          />
          <datalist id="custom-ai-models">
            {models.map(model => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <TextField
            select
            label="Reasoning effort"
            value={config.reasoningEffort}
            onChange={event => update({ reasoningEffort: event.target.value })}
          >
            {['low', 'medium', 'high'].map(effort => (
              <MenuItem key={effort} value={effort}>
                {effort}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label={
              config.credentialReference
                ? 'Replace bearer key (optional)'
                : 'Bearer key (optional)'
            }
            type="password"
            value={key}
            onChange={event => setKey(event.target.value)}
            autoComplete="off"
          />
          <LineStackLayout>
            <FlatButton
              label={<Trans>Save key</Trans>}
              disabled={busy || !config.endpoint}
              onClick={() =>
                run(async () => {
                  const result = await invokeCustomAi('set-key', {
                    endpoint: config.endpoint,
                    key,
                  });
                  update({
                    credentialReference: key
                      ? result.credentialReference
                      : null,
                  });
                  setKey('');
                  return result.sessionOnly
                    ? 'Encryption unavailable: the key is stored for this session only.'
                    : key
                    ? 'Key encrypted and saved.'
                    : 'Saved key removed.';
                })
              }
            />
            <FlatButton
              label={<Trans>Refresh models</Trans>}
              disabled={busy || !config.endpoint}
              onClick={() =>
                run(async () => {
                  const result = await invokeCustomAi('models', config);
                  setModels(result.models);
                  return `${result.models.length} models found.${
                    result.proxyVersion
                      ? ' Proxy version: ' + result.proxyVersion
                      : ''
                  }`;
                })
              }
            />
            <FlatButton
              label={<Trans>Test connection</Trans>}
              disabled={busy || !config.model || !config.endpoint}
              onClick={() =>
                run(async () => {
                  const result = await invokeCustomAi('test', config);
                  return `Connected to ${result.model}: ${result.text}`;
                })
              }
            />
          </LineStackLayout>
          {status && <Text>{status}</Text>}
          <Text>
            <Trans>
              Each conversation keeps the endpoint, protocol, model, and
              credential reference it started with. Change these settings to
              start a new conversation.
            </Trans>
          </Text>
        </React.Fragment>
      )}
    </ColumnStackLayout>
  );
}
