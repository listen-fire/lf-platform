import { z } from 'zod';

import { promptDef } from '../definition';
import { notNull } from '../../utils/nullability';

import { THEMES } from 'platform-constants/themes';

const aggregateThemesDef = promptDef({
  description: 'Aggregate a list of themes into a single list.',
  arguments: ['themes'],
  messages: [
    {
      role: 'system',
      content: `Your job is to produce a strict set of THEMES from a set of tags. The following THEMES are available:
${THEMES.join('\n')}
`,
    },
    {
      role: 'user',
      content: `Condense the following list of tags into a small list of THEMES.
Tags:
{{{themes}}}

You must output a JSON array of THEMES and nothing else. If there are no tags or there's any other reason you can't fulfil this request, output an empty array.
`,
    },
  ],
  validator: z.array(z.enum(THEMES).nullable().catch(null)).transform((arr) => arr.filter(notNull)),
  fallback: [],
} as const);

export { aggregateThemesDef };
