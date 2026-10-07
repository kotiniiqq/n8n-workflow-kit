/** Support intake: a web form posts a ticket; we validate it, route it to a helpdesk queue
 *  and answer the form with the queue, or with the validation errors.
 *
 *  Webhook -> Normalize Ticket -> Valid? -> Route Ticket -> Create Helpdesk Ticket -> 202
 *                                        \-> 400 with errors
 */
import { ifElse, node, trigger, workflow } from '@n8n/workflow-sdk';

import { codeNode } from '../kit/code.ts';
import { cred, envValue } from '../kit/placeholders.ts';

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: {
    name: 'Incoming Ticket',
    parameters: { httpMethod: 'POST', path: 'support-intake', responseMode: 'responseNode' },
  },
});

const normalize = codeNode('Normalize Ticket', 'code/normalize-ticket.ts');

const isValid = ifElse({
  version: 2.2,
  config: {
    name: 'Valid?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ $json.valid }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});

const route = codeNode('Route Ticket', 'code/route-ticket.ts');

const createTicket = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Create Helpdesk Ticket',
    parameters: {
      method: 'POST',
      url: envValue('helpdeskUrl'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ ...$json.ticket, queue: $json.queue, priority: $json.priority }) }}',
      options: { timeout: 10000 },
    },
    credentials: cred('httpHeaderAuth', 'helpdesk-api'),
  },
});

const accepted = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Respond Accepted',
    parameters: {
      respondWith: 'json',
      responseBody: "={{ JSON.stringify({ status: 'accepted', queue: $('Route Ticket').item.json.queue }) }}",
      options: { responseCode: 202 },
    },
  },
});

const rejected = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.1,
  config: {
    name: 'Respond Invalid',
    parameters: {
      respondWith: 'json',
      responseBody: "={{ JSON.stringify({ status: 'invalid', errors: $json.errors }) }}",
      options: { responseCode: 400 },
    },
  },
});

export default workflow('support-intake', 'support-intake')
  .add(webhook)
  .to(normalize)
  // the SDK types onTrue as optional on a generic node; on an If node it always exists
  .to(isValid.onTrue!(route.to(createTicket).to(accepted)).onFalse(rejected));
