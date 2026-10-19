import * as db from '@prisma/client';

import { DocumentProvider } from './document/interface';
import { OcrAdapter } from './ocr/interface';
import type { OutboundEmailMessager } from '@listen-fire/email';
import { OutboundWhatsAppMessager } from './whatsapp/interface';
import { LinkedinAdapter } from './linkedin/interface';
import { SlackConnector } from './slack/interface';
import { AirtableConnector } from './airtable/interface';
import { AttioConnector } from './attio/interface';
import { GoogleConnector } from './google/interface';
import { DropboxAppAdapter } from './dropbox/connector';
import { GmailAppAdapter } from './gmail/connector';
import { SlackMonitoring } from '../lib/slack';

class Registry {
  private static instance: Registry;

  private constructor() {}

  static getInstance() {
    if (!Registry.instance) {
      Registry.instance = new Registry();
    }
    return Registry.instance;
  }

  private _email?: OutboundEmailMessager;
  set email(emailMessager: OutboundEmailMessager) {
    this._email = emailMessager;
  }

  get email() {
    if (!this._email) {
      throw new Error('Email adapter not registered');
    }
    return this._email;
  }

  private _whatsapp?: OutboundWhatsAppMessager;
  set whatsapp(whatsappMessager: OutboundWhatsAppMessager) {
    this._whatsapp = whatsappMessager;
  }

  get whatsapp() {
    if (!this._whatsapp) {
      throw new Error('WhatsApp adapter not registered');
    }
    return this._whatsapp;
  }

  private _document?: DocumentProvider;
  set document(documentProvider: DocumentProvider) {
    this._document = documentProvider;
  }

  get document() {
    if (!this._document) {
      throw new Error('Document adapter not registered');
    }
    return this._document;
  }

  private _ocr?: OcrAdapter;
  set ocr(ocrAdapter: OcrAdapter) {
    this._ocr = ocrAdapter;
  }

  get ocr() {
    if (!this._ocr) {
      throw new Error('OCR adapter not registered');
    }
    return this._ocr;
  }

  private _linkedin?: LinkedinAdapter | undefined;
  set linkedin(linkedinAdapter: LinkedinAdapter | undefined) {
    this._linkedin = linkedinAdapter;
  }

  get linkedin() {
    return this._linkedin;
  }

  private _slack?: SlackConnector | undefined;
  set slack(slackApp: SlackConnector | undefined) {
    this._slack = slackApp;
  }

  get slack() {
    return this._slack;
  }

  private _airtable?: AirtableConnector | undefined;
  set airtable(airtableApp: AirtableConnector | undefined) {
    this._airtable = airtableApp;
  }

  get airtable() {
    return this._airtable;
  }

  private _attio?: AttioConnector | undefined;
  set attio(attioApp: AttioConnector | undefined) {
    this._attio = attioApp;
  }

  get attio() {
    return this._attio;
  }

  private _google?: GoogleConnector | undefined;
  set google(googleApp: GoogleConnector | undefined) {
    this._google = googleApp;
  }

  get google() {
    return this._google;
  }

  // Registered only when this deployment connects Gmail by OAuth
  // (GMAIL_CONNECT_METHOD) and carries the Google integrations client pair.
  // Absent under the delegated method — there is no sign-in to run.
  private _gmail?: GmailAppAdapter | undefined;
  set gmail(gmailApp: GmailAppAdapter | undefined) {
    this._gmail = gmailApp;
  }

  get gmail() {
    return this._gmail;
  }

  private _dropbox?: DropboxAppAdapter | undefined;
  set dropbox(dropboxApp: DropboxAppAdapter | undefined) {
    this._dropbox = dropboxApp;
  }

  get dropbox() {
    return this._dropbox;
  }

  private _slackMonitoring?: SlackMonitoring | undefined;
  set slackMonitoring(slackMonitoring: SlackMonitoring | undefined) {
    this._slackMonitoring = slackMonitoring;
  }

  get slackMonitoring() {
    return this._slackMonitoring;
  }

}

const services = Registry.getInstance();

export { services };
