/**
 * The ArtCraft product registry: every `*craft` app, its CLI, and how that CLI
 * spells a headless run.
 *
 * This is the single source of truth shared by the Cordis plugins, the MCP
 * bridge, the catalog generator and the verifier. Every field below was read
 * off the real CLI's `--help`/`commands` output (see `docs/CRAFT-MATRIX.md`).
 *
 * Plain `.mjs`, not TypeScript: the Node scripts under `scripts/` load it
 * directly with no build step, and the TypeScript plugins import it through
 * `profiles.ts`.
 * @module @dsh-artcraft/craft-kit/profiles
 */

/** @typedef {import('./types.ts').CraftProfile} CraftProfile */

/** Directory (relative to the workspace root) holding the installed CLIs. */
export const CRAFTS_BIN_DIR = 'crafts-bin'

/** Path of the cloned upstream sources, relative to the workspace root. */
export const REPOS_DIR = 'repos'

/**
 * Every craft app, in catalog order.
 *
 * `release: false` marks a repository with no runnable desktop CLI release, so
 * `fetch-binaries.mjs` skips it and the plugin works from source or a
 * `path` override instead.
 * @type {readonly CraftProfile[]}
 */
export const CRAFT_PROFILES = [
  {
    id: 'cadcraft',
    product: 'CADCraft',
    bin: 'cadcraft-cli',
    envVar: 'CADCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.dxf', '.dwg'],
    blurb: 'Computer-aided design and drafting (AutoCAD-style): lines, arcs, splines, layers, dimensions, hatches, blocks.',
    run: {
      verb: 'run',
      inputMode: 'positional',
      inFlag: '',
      sampleFlag: '--sample',
      cmdFlag: '--cmd',
      cmdSeparator: '=',
      saveFlag: '--save',
      exportFlag: '--export',
    },
    reads: [
      { name: 'inspect', verb: 'info', summary: 'Summarize a DXF/DWG drawing: entities, layers, extents.' },
      { name: 'convert', verb: 'convert', summary: 'Convert a drawing between dxf/dwg/svg/png/pdf.' },
    ],
    catalogJson: true,
    catalogArgs: ['commands'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'gridcraft',
    product: 'GridCraft',
    bin: 'gridcraft-cli',
    envVar: 'GRIDCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.xlsx', '.csv', '.tsv', '.json', '.html'],
    blurb: 'Spreadsheets (Excel-style): cells, formulas, 500+ worksheet functions, tables, charts, conditional formatting.',
    run: {
      verb: 'run',
      inFlag: '--in',
      sampleFlag: '--sample',
      samples: ['budget', 'sales', 'grades'],
      cmdFlag: '--cmd',
      cmdSeparator: '=',
      saveFlag: '--out',
      printFlag: '--print',
    },
    reads: [
      { name: 'inspect', verb: 'info', summary: 'Summarize a workbook: sheets, used ranges, tables, charts, names.' },
      { name: 'convert', verb: 'convert', summary: 'Convert a workbook between xlsx/csv/tsv/json/html.' },
    ],
    catalogJson: true,
    catalogArgs: ['commands', '--json'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'soundcraft',
    product: 'SoundCraft',
    bin: 'soundcraft-cli',
    envVar: 'SOUNDCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.scraft', '.wav', '.aiff'],
    blurb: 'Digital audio workstation (Pro Tools-style): multitrack editing, mixing, plugins, automation, MIDI, bouncing.',
    run: {
      verb: 'run',
      inFlag: '--in',
      sampleFlag: '--demo',
      cmdFlag: '--cmd',
      cmdSeparator: '=',
      saveFlag: '--save',
      exportFlag: '--bounce',
      printFlag: '--inspect',
    },
    reads: [
      { name: 'inspect', verb: 'info', summary: 'Summarize an audio file or .scraft session.' },
      { name: 'convert', verb: 'convert', summary: 'Convert or resample audio between formats and bit depths.' },
    ],
    catalogJson: false,
    describeArgs: ['describe'],
    catalogArgs: ['commands'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'deckcraft',
    product: 'DeckCraft',
    bin: 'deckcraft-cli',
    envVar: 'DECKCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.deckcraft', '.pptx'],
    blurb: 'Presentations (PowerPoint-style): slides, layouts, themes, shapes, pictures, tables, charts, transitions.',
    run: {
      verb: 'run',
      inFlag: '--in',
      sampleFlag: '--sample',
      cmdFlag: '--cmd',
      cmdSeparator: '=',
      saveFlag: '--save',
      exportFlag: '--export',
      printFlag: '--print',
    },
    reads: [
      { name: 'inspect', verb: 'info', summary: 'Summarize a deck: slide count, layouts, sizes.' },
      { name: 'convert', verb: 'convert', summary: 'Convert a deck between .deckcraft, .pptx and exported formats.' },
    ],
    catalogJson: true,
    catalogArgs: ['commands'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'wordcraft',
    product: 'WordCraft',
    bin: 'wordcraft-cli',
    envVar: 'WORDCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.docx', '.odt', '.rtf', '.md', '.txt', '.pdf'],
    blurb: 'Word processing (Word-style): styled text, tables, headers, footnotes, tracked changes, comments, mail merge.',
    run: {
      verb: 'run',
      inFlag: '--file',
      sampleFlag: '--template',
      cmdFlag: '--cmd',
      cmdSeparator: '=',
      saveFlag: '--save',
      printFlag: '--print',
    },
    reads: [
      { name: 'inspect', verb: 'inspect', summary: 'Dump a document\'s structure (pages, paragraphs, styles) as JSON.' },
      { name: 'convert', verb: 'convert', summary: 'Convert a document between docx/doc/pdf/odt/rtf/html/md/tex/txt.' },
    ],
    catalogJson: true,
    catalogArgs: ['commands', '--json'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'photocraft',
    product: 'PhotoCraft',
    bin: 'photocraft-cli',
    envVar: 'PHOTOCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.pcraft', '.psd', '.png', '.jpg', '.tif', '.webp', '.exr'],
    blurb: 'Raster image editor (Photoshop-style): layers, selections, adjustments, filters, droplets, batch actions.',
    run: {
      verb: 'run',
      inputMode: 'none',
      inFlag: '',
      sampleFlag: '--new',
      newSampleValue: '{"width":1920,"height":1080}',
      cmdFlag: '--cmd',
      cmdSeparator: '',
      cmdStyle: 'flag-params',
      cmdParamsFlag: '--params',
      saveFlag: '--out',
    },
    reads: [
      { name: 'inspect', verb: 'info', summary: 'Print a document as JSON: size, mode, depth, layer tree.' },
      { name: 'convert', verb: 'convert', summary: 'Convert between .pcraft/.psd/.png/.jpg/.tif/.webp/.exr.' },
    ],
    catalogJson: true,
    catalogArgs: ['commands', '--json'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'lightcraft',
    product: 'LightCraft',
    bin: 'lightcraft-cli',
    envVar: 'LIGHTCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.lcraft', '.jpg', '.raw', '.dng', '.cr2', '.nef'],
    blurb: 'Non-destructive photo library and raw developer (Lightroom-style): catalogs, develop settings, export.',
    run: {
      verb: 'run',
      inFlag: '',
      sampleFlag: '--demo',
      cmdFlag: '',
      cmdSeparator: ' ',
      cmdStyle: 'positional-kv',
      positionalKeyValues: true,
      importFlag: '--import',
      saveFlag: '--library',
    },
    reads: [
      { name: 'inspect', verb: 'commands', arg: 'none', summary: 'List LightCraft commands and their parameter names.' },
    ],
    catalogJson: false,
    catalogArgs: ['commands'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'pdfcraft',
    product: 'PdfCraft',
    bin: 'pdfcraft-cli',
    envVar: 'PDFCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.pdf'],
    blurb: 'PDF reader and editor: page operations, text extraction, rendering, combining, redaction audit.',
    run: {
      verb: 'run',
      inputMode: 'none',
      inFlag: '',
      sampleFlag: '',
      cmdFlag: '',
      cmdSeparator: ' ',
      cmdStyle: 'positional-kv',
      positionalKeyValues: true,
      saveMode: 'none',
      // `run --script FILE` executes a whole step list in one process, which is
      // how multi-step work is expressed here: `run` itself takes one tool.
      scriptFlag: '--script',
      saveFlag: '--out',
    },
    reads: [
      { name: 'inspect', verb: 'info', summary: 'Summarize a PDF: pages, metadata, encryption.' },
      { name: 'convert', verb: 'render', summary: 'Render a PDF page to a png/jpg/tif/pam image.' },
    ],
    catalogJson: true,
    catalogArgs: ['tools'],
    oneToolPerRun: true,
    mcpArgs: ['mcp'],
  },
  {
    id: 'vectorcraft',
    product: 'VectorCraft',
    bin: 'vectorcraft-cli',
    envVar: 'VECTORCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.vcraft', '.svg', '.ai', '.pdf', '.eps'],
    blurb: 'Vector art (Illustrator-style): paths, artboards, text, effects, packaging, format export.',
    run: {
      verb: 'run',
      inFlag: '--in',
      sampleFlag: '',
      cmdFlag: '--cmd',
      cmdSeparator: '',
      cmdStyle: 'flag-params',
      cmdParamsFlag: '--params',
      // VectorCraft renders documents and artifacts through one flag, so both
      // names map to it: the kernel folds `export` into `save` when they match.
      saveFlag: '--export',
      exportFlag: '--export',
    },
    reads: [
      { name: 'convert', verb: 'convert', summary: 'Open any readable format and export it to another.' },
    ],
    catalogJson: true,
    catalogArgs: ['commands'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'effectcraft',
    product: 'EffectCraft',
    bin: 'effectcraft-cli',
    envVar: 'EFFECTCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.ecproject', '.ectemplate'],
    blurb: 'Motion graphics and compositing (After Effects-style): comps, layers, properties, expressions, render queue.',
    run: {
      verb: 'run',
      inFlag: '',
      sampleFlag: '',
      cmdFlag: '',
      cmdSeparator: ' ',
      cmdStyle: 'positional-pair',
      saveMode: 'none',
    },
    reads: [
      { name: 'inspect', verb: 'info', summary: 'Summarize the project and render engine.' },
      { name: 'convert', verb: 'render', summary: 'Render a comp to a movie or image sequence.' },
    ],
    catalogJson: false,
    catalogArgs: ['commands', '--json'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'filmcraft',
    product: 'FilmCraft',
    bin: 'filmcraft-cli',
    envVar: 'FILMCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.fcraft', '.mp4', '.mov'],
    blurb: 'Nonlinear video editor: project tree, sequences, media import, export presets.',
    run: {
      verb: 'run',
      inFlag: '',
      sampleFlag: '',
      cmdFlag: '',
      cmdSeparator: ' ',
      cmdStyle: 'positional-pair',
      scriptMode: true,
      // FilmCraft writes the project with the global `--save-as FILE`, which
      // must precede the `run` subcommand.
      saveMode: 'flag',
      saveFlag: '--save-as',
    },
    reads: [
      {
        name: 'inspect',
        verb: 'inspect',
        summary: 'Project tree or active sequence as JSON.',
        arg: 'section',
        section: 'project',
        projectFlag: '--project',
      },
      { name: 'convert', verb: 'export', summary: 'Export the active sequence to a movie with a preset or format.' },
    ],
    catalogJson: true,
    describeArgs: ['describe'],
    catalogArgs: ['commands', '--json'],
    mcpArgs: ['mcp'],
  },
  {
    id: 'designcraft',
    product: 'DesignCraft',
    bin: 'designcraft-cli',
    envVar: 'DESIGNCRAFT_CLI',
    searchDirs: [CRAFTS_BIN_DIR],
    extensions: ['.dcraft', '.pdf'],
    blurb: 'Page and layout design (InDesign-style): documents, master pages, frames, text flow, PDF export.',
    run: {
      verb: 'run',
      inFlag: '--in',
      sampleFlag: '--sample',
      cmdFlag: '--cmd',
      cmdSeparator: '=',
      saveMode: 'none',
      saveFlag: '--save',
      exportFlag: '--export',
      exportAllPagesFlag: '--all-pages',
    },
    reads: [],
    catalogJson: true,
    catalogArgs: ['commands'],
    mcpArgs: ['mcp'],
  },
]

/** Profile lookup by craft id. */
export const PROFILES_BY_ID = new Map(CRAFT_PROFILES.map(profile => [profile.id, profile]))

/**
 * The craft profile for `id`.
 * @param {string} id - craft id, e.g. `gridcraft`.
 * @returns {CraftProfile | undefined} the profile.
 */
export function profileOf(id) {
  return PROFILES_BY_ID.get(id)
}
