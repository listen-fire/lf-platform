import { PitchDotComService } from '../../documents/pitch_dot_com';

describe('getFirstPageUrl', () => {
  [
    {
      title: 'No page UUID',
      url: 'https://pitch.com/v/tinyvc-ds46s6',
      expected: 'https://pitch.com/v/tinyvc-ds46s6',
    },
    {
      title: 'Page UUID',
      url: 'https://pitch.com/v/tinyvc-ds46s6/1',
      expected: 'https://pitch.com/v/tinyvc-ds46s6',
    },
    {
      title: 'Page UUID with query params',
      url: 'https://pitch.com/v/tinyvc-ds46s6/1?foo=bar',
      expected: 'https://pitch.com/v/tinyvc-ds46s6?foo=bar',
    },
    {
      title: 'Page UUID with hash',
      url: 'https://pitch.com/v/tinyvc-ds46s6/1#foo',
      expected: 'https://pitch.com/v/tinyvc-ds46s6#foo',
    },
    {
      title: 'Page UUID with query params and hash',
      url: 'https://pitch.com/v/tinyvc-ds46s6/1?foo=bar#baz',
      expected: 'https://pitch.com/v/tinyvc-ds46s6?foo=bar#baz',
    },
    {
      title: 'Real world example 1',
      url: 'https://pitch.com/public/41973746-2fbf-440c-a3fc-849b31f3402d/ea53c65f-d2a2-4151-8fde-8bc03562e979',
      expected: 'https://pitch.com/public/41973746-2fbf-440c-a3fc-849b31f3402d',
    },
    {
      title: 'Real world example 2',
      url: 'https://pitch.com/v/Sensitive-Seed---Teaser-k6ae64/b8b95893-0954-4e8e-93ec-52702e9451e8',
      expected: 'https://pitch.com/v/Sensitive-Seed---Teaser-k6ae64',
    },
    {
      title: 'Real world example 3',
      url: 'https://pitch.com/public/0adab90f-abcb-55d9-a04b-5ddbf6e9f0e0',
      expected: 'https://pitch.com/public/0adab90f-abcb-55d9-a04b-5ddbf6e9f0e0',
    },
  ].forEach(({ title, url, expected }) => {
    it(title, () => {
      expect(PitchDotComService.getFirstPageUrl(url)).toEqual(expected);
    });
  });
});
