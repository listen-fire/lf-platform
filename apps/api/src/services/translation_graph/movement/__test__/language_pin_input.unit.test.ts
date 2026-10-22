import { LANGUAGE_VERSION } from 'movement-lang';

import { languageVersionInput, pinFromInput } from '../language_pin_input';

describe('pinFromInput', () => {
  it('passes a string through as the pin', () => {
    expect(pinFromInput('0.12.0')).toEqual({ pin: '0.12.0' });
    expect(pinFromInput('4')).toEqual({ pin: '4' });
  });

  it('reads the integer 5 as the installed language', () => {
    expect(pinFromInput(5)).toEqual({ pin: LANGUAGE_VERSION });
  });

  it('reads 1 to 4 as the legacy ids', () => {
    expect(pinFromInput(4)).toEqual({ pin: '4' });
    expect(pinFromInput(1)).toEqual({ pin: '1' });
  });

  it('refuses any other integer, naming the accepted forms', () => {
    const refused = pinFromInput(7);
    expect(refused).toEqual({ error: expect.stringContaining(`"${LANGUAGE_VERSION}"`) });
    expect(pinFromInput(0)).toHaveProperty('error');
  });

  it('the input schema takes a string or an integer, not a fraction', () => {
    expect(languageVersionInput.safeParse('0.12.0').success).toBe(true);
    expect(languageVersionInput.safeParse(5).success).toBe(true);
    expect(languageVersionInput.safeParse(1.5).success).toBe(false);
  });
});
