// How a credential row reads on lf's secrets wire, and the row an lf entry
// becomes: the external it is bound to, its binding, and how its stored
// payload reads as fields.

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { GMAIL_APP_ID } from '../../credentials/app_id';
import { camelTokenPayloadShape, flatPayloadShape, renamedPayloadShape } from '../../credentials/secrets_postgres';
import { gmailOAuthPayloadShape } from '../../../adapters/gmail/module_credential';
import { wireReading, wireTarget, type StoredBinding } from '../rows';

const row = (over: Partial<StoredBinding> & Pick<StoredBinding, 'type'>): StoredBinding => ({
  app_id: null,
  declared_credential: null,
  wire_binding: null,
  ...over,
});

describe('a row as lf reads it', () => {
  it('a remote install reads as its module, bound as the install', () => {
    const reading = wireReading(row({ type: ExternalServiceType.REMOTE, app_id: 'acme_crm' }));
    expect(reading).toMatchObject({ external: 'acme_crm', binding: 'install' });
    expect(reading?.shape).toBe(flatPayloadShape);
  });

  it('a remote provider credential reads as the credential it fills', () => {
    const reading = wireReading(row({ type: ExternalServiceType.REMOTE, app_id: 'acme_crm', declared_credential: 'oauth' }));
    expect(reading).toMatchObject({ external: 'acme_crm', binding: { credential: 'oauth' } });
  });

  it('the binding lf named is what it reads back', () => {
    expect(wireReading(row({ type: ExternalServiceType.REMOTE, app_id: 'acme_crm', declared_credential: 'oauth', wire_binding: 'legacy' }))?.binding).toBe('legacy');
    expect(wireReading(row({ type: ExternalServiceType.DROPBOX, wire_binding: 'install' }))?.binding).toBe('install');
  });

  it('a built-in type reads as its module line, bound to the credential the module declares, in the shape its line stores', () => {
    const dropbox = wireReading(row({ type: ExternalServiceType.DROPBOX }));
    expect(dropbox).toMatchObject({ external: 'dropbox', binding: { credential: 'dropbox' } });
    expect(dropbox?.shape).toBe(camelTokenPayloadShape);

    const attio = wireReading(row({ type: ExternalServiceType.ATTIO }));
    expect(attio).toMatchObject({ external: 'attio', binding: { credential: 'attio' } });
    expect(attio?.shape.toFields({ accessToken: 't1' })).toEqual(renamedPayloadShape({ accessToken: 'access_token' }).toFields({ accessToken: 't1' }));

    const dealroom = wireReading(row({ type: ExternalServiceType.DEALROOM }));
    expect(dealroom).toMatchObject({ external: 'dealroom', binding: { credential: 'dealroom' } });
    expect(dealroom?.shape).toBe(flatPayloadShape);

    expect(wireReading(row({ type: ExternalServiceType.SLACK, app_id: 'listen-fire' }))).toMatchObject({ external: 'slack', binding: { credential: 'slack' } });
  });

  it('GOOGLE reads as the first of its two lines, google_sheets', () => {
    expect(wireReading(row({ type: ExternalServiceType.GOOGLE }))).toMatchObject({ external: 'google_sheets', binding: { credential: 'google' } });
  });

  it('a signed-in Gmail mailbox reads in the Gmail payload shape', () => {
    const gmail = wireReading(row({ type: ExternalServiceType.GOOGLE_GMAIL, app_id: GMAIL_APP_ID.oauthMailbox }));
    expect(gmail).toMatchObject({ external: 'gmail', binding: { credential: 'gmail' } });
    expect(gmail?.shape).toBe(gmailOAuthPayloadShape);
  });

  it('is not served: a delegated or retired Gmail row, a type no module line names, and the platform\'s own keys', () => {
    expect(wireReading(row({ type: ExternalServiceType.GOOGLE_GMAIL, app_id: GMAIL_APP_ID.delegatedMailbox }))).toBeNull();
    expect(wireReading(row({ type: ExternalServiceType.GOOGLE_GMAIL, app_id: GMAIL_APP_ID.legacySignIn }))).toBeNull();
    expect(wireReading(row({ type: ExternalServiceType.GOOGLE_GMAIL }))).toBeNull();
    for (const type of [
      ExternalServiceType.MAILGUN,
      ExternalServiceType.TWILIO,
      ExternalServiceType.PIPEDRIVE,
      ExternalServiceType.SLACK_QUERY,
      ExternalServiceType.NATIVE_VALUATIONS,
      ExternalServiceType.NATIVE_KNOWLEDGE,
    ]) {
      expect(wireReading(row({ type }))).toBeNull();
    }
    expect(wireReading(row({ type: ExternalServiceType.REMOTE }))).toBeNull();
  });
});

describe('the row an lf entry becomes', () => {
  it('a known external is its type, its payload in the line\'s stored shape', () => {
    const target = wireTarget({ external: 'dropbox', binding: { credential: 'dropbox' } });
    expect(target).toMatchObject({ type: ExternalServiceType.DROPBOX, declaredCredential: null, wireBinding: null });
    const expiresAt = '2026-10-22T12:00:00.000Z';
    expect(target.shape.withFields({}, { access_token: 'a1', refresh_token: 'r1', expires_at: expiresAt })).toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: Date.parse(expiresAt),
    });
  });

  it('a Gmail entry is a signed-in mailbox', () => {
    expect(wireTarget({ external: 'gmail', binding: { credential: 'gmail' } })).toMatchObject({
      type: ExternalServiceType.GOOGLE_GMAIL,
      appId: GMAIL_APP_ID.oauthMailbox,
    });
  });

  it('either Google line is a GOOGLE credential', () => {
    expect(wireTarget({ external: 'google_drive', binding: { credential: 'google' } }).type).toBe(ExternalServiceType.GOOGLE);
    expect(wireTarget({ external: 'google_sheets', binding: { credential: 'google' } }).type).toBe(ExternalServiceType.GOOGLE);
  });

  it('an unknown external is a remote module\'s credential, its binding kept in the row', () => {
    expect(wireTarget({ external: 'acme_crm', binding: { credential: 'oauth' } })).toMatchObject({
      type: ExternalServiceType.REMOTE,
      appId: 'acme_crm',
      declaredCredential: 'oauth',
      wireBinding: null,
      shape: flatPayloadShape,
    });
    expect(wireTarget({ external: 'acme_crm', binding: 'legacy' })).toMatchObject({ declaredCredential: null, wireBinding: 'legacy' });
    expect(wireTarget({ external: 'acme_crm', binding: 'install' })).toMatchObject({ declaredCredential: null, wireBinding: 'install' });
  });

  it('reads back as what lf wrote', () => {
    for (const entry of [
      { external: 'acme_crm', binding: { credential: 'oauth' } },
      { external: 'acme_crm', binding: 'legacy' as const },
      { external: 'dropbox', binding: 'install' as const },
      { external: 'attio', binding: { credential: 'attio' } },
    ]) {
      const target = wireTarget(entry);
      expect(wireReading({ type: target.type, app_id: target.appId, declared_credential: target.declaredCredential, wire_binding: target.wireBinding })).toMatchObject(entry);
    }
  });
});
