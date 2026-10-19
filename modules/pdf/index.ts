// `@lf/pdf`: draws text as a PDF file. A movement imports it as the package
// (``import { `@lf/pdf` as pdf } from plugins``) and calls `pdf.render(text)`,
// which answers a record whose `file` is the PDF.
//
// The writer here is a thin one: Helvetica, no font to ship, so the core image
// stays small. A character outside Latin-1 prints as "?" and the run is warned,
// naming this module. Full Unicode comes from another module that serves the
// same plugin (one that embeds a font): swap it in for this one.
//
// The declaration (what it accepts, what it hands back) is the engine
// package's data, so the checker reads one description wherever the module
// runs; this module supplies the body. The platform loads it in process, every
// other host serves it as a process with `serve-module`.

import type { PluginModuleDefinition } from 'module-kit';

import { defineModule } from 'module-kit';
import { PDF_PLUGINS, RENDER_PLUGIN, pluginProgramName } from 'movement-engine/public/plugins';
import { renderPlugin } from './render';

export const pdfModule: PluginModuleDefinition = defineModule({
  kind: 'plugin',
  name: '@lf/pdf',
  credentials: [],
  plugins: PDF_PLUGINS,
  create: () => ({
    async invokePlugin({ name, config }) {
      if (pluginProgramName(name) !== pluginProgramName(RENDER_PLUGIN.signature.name)) throw new Error(`@lf/pdf has no plugin "${name}"`);
      return renderPlugin(config);
    },
  }),
});

export default pdfModule;

export { renderPlugin, lackingWarning } from './render';
export * from './plain_text_pdf';
