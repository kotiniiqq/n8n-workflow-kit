/** Error workflow: every other workflow points its settings.errorWorkflow here.
 *  Error Trigger -> Format Error (tested module) -> Telegram. */
import { node, trigger, workflow } from '@n8n/workflow-sdk';

import { codeNode } from '../kit/code.ts';
import { cred, envValue } from '../kit/placeholders.ts';

const onError = trigger({
  type: 'n8n-nodes-base.errorTrigger',
  version: 1,
  config: { name: 'On Workflow Error' },
});

const format = codeNode('Format Error', 'code/format-error.ts');

const send = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send Alert',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: envValue('alertsChatId'),
      text: '={{ $json.text }}',
      additionalFields: { parse_mode: 'HTML', appendAttribution: false, disable_web_page_preview: true },
    },
    credentials: cred('telegramApi', 'alerts-bot'),
  },
});

export default workflow('error-alert', 'error-alert').add(onError).to(format).to(send);
