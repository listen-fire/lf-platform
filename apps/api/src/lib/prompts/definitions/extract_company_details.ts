import { z } from 'zod';

import { promptDef } from '../definition';

import { THEMES } from 'story-view/constants/themes';

const extractCompanyDetailsDef = promptDef({
  // Ideally the concerns of this prompt would be split into multiple prompts
  // but we're trying to keep the number of prompts low for now due to OpenAI's rate limits.
  // We have to send the entire input message for every prompt, which uses up a lot of tokens.
  // Ideally we'd just send the most relevant pages, but the embeddings aren't reliable enough.
  // So we're trading off the coupling and potential quality here for availability.
  description: 'Extract details about a company to supplement the identified entity.',
  arguments: ['message', 'companyName'],
  messages: [
    {
      role: 'system',
      content: `You are a function in a data pipeline.
We receive text (the INPUT) that contains information about an entity (like startups, founders, investors, funds, etc).
I'll send you some text that has one particular entity ({{{companyName}}}) as the subject.

You must respond with a JSON object where the keys are:
- country (string): the country ISO where the entity is based  
- city (string): the city where the entity is based
- themes (string[]): the market themes that best describe the entity

The available themes are:
${THEMES.map((theme) => `- ${theme}`).join('\n')}

All attributes are optional and should be null if there is no value.
Do not include any information in your response that is not in the INPUT.

Your response will be parsed as JSON, so the entire response must be valid JSON and start with the character "{".
    `,
    },
    { role: 'user', content: '{{{message}}}' },
  ],
  validator: z.object({
    country: z.string().nullable(),
    city: z.string().nullable(),
    themes: z.preprocess(
      (themes) =>
        themes === null
          ? null
          : (themes as string[]).filter((theme) =>
              THEMES.includes(theme as (typeof THEMES)[number]),
            ),
      z.enum(THEMES).array().nullable(),
    ),
  }),
  fallback: {
    country: null,
    city: null,
    themes: null,
  },
  model: 'claude-sonnet-5',
} as const);
export { extractCompanyDetailsDef };
