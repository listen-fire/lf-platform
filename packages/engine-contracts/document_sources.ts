export const DOCSEND_REGEX =
  /^https:\/\/(([\w-]+\.)?docsend\.com|docsend\.dropbox\.com)\/\S+$/;
export const GOOGLE_DOCS_REGEX =
  /^https:\/\/docs\.google\.com\/(presentation|document)\/\S+$/;
export const GOOGLE_DRIVE_REGEX = /^https:\/\/drive\.google\.com\/\S+$/;
export const PITCH_DOT_COM_REGEX = /^https:\/\/pitch\.com\/\S+$/;
export const FIGMA_REGEX =
  /^https:\/\/([\w]+\.)?figma\.com\/(proto|deck)\/\S+$/;
export const PDF_REGEX = /^https?:\/\/[^?\s]+\.pdf($|\?)/;
export const PPTX_REGEX = /^https?:\/\/[^?\s]+\.pptx($|\?)/;
export const XLSX_REGEX = /^https?:\/\/[^?\s]+\.xlsx($|\?)/;
export const BRIEFLINK_REGEX = /^https:\/\/brieflink\.com\/v\/\S+$/;
export const TOME_REGEX = /^https:\/\/tome\.app\/\S+$/;
export const CANVA_REGEX = /^https:\/\/www\.canva\.com\/design\/\S+\/view\S*$/;
export const NOTION_REGEX =
  /^https:\/\/(?:(?:www\.)?notion\.so|app\.notion\.com|[a-zA-Z0-9-]+\.notion\.site)\/\S+$/;
export const PAPERMARK_REGEX =
  /^https:\/\/(www\.)?(papermark\.io|papermark\.com)\/view\/\S+$/;

export const FULLY_SUPPORTED_DOCUMENT_REGEXES = [
  DOCSEND_REGEX,
  GOOGLE_DOCS_REGEX,
  GOOGLE_DRIVE_REGEX,
  PITCH_DOT_COM_REGEX,
  PDF_REGEX,
  PPTX_REGEX,
  XLSX_REGEX,
  BRIEFLINK_REGEX,
  // TOME_REGEX, when next tome.app deck is submitted, test it, then enable
  FIGMA_REGEX,
  CANVA_REGEX,
  PAPERMARK_REGEX,
];
