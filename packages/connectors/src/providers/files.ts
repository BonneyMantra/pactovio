import { ActionError, type ActionCtx, type ProviderActions } from '../actions';
import { deepFind, deepFindArray, mimeFor } from '../util';

function payload(i: Record<string, any>, ctx: ActionCtx) { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (ctx.file) return ctx.file;
  const filename = String(i.filename ?? '');
  if (!filename) throw new ActionError('filename is required', 'bad_input');
  if (typeof i.text !== 'string') throw new ActionError('Provide r2_key or text', 'bad_input');
  return { filename, mimetype: String(i.mimetype ?? mimeFor(filename)), bytes: new TextEncoder().encode(i.text) };
}

const SAMPLE = { filename: 'pactovio-connector-test.txt', text: 'Uploaded by the Pactovio connector test. Safe to delete.' };
const FOLDER = 'Pactovio';

async function driveFolder(ctx: ActionCtx): Promise<string | null> {
  const saved = ctx.meta.config?.folder_id as string | undefined;
  if (saved) return saved;
  const found = await ctx.exec('GOOGLEDRIVE_FIND_FILE', { q: `name = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, pageSize: 1 });
  let id = deepFind((deepFindArray(found, ['files']) ?? [])[0], ['id']);
  if (!id) id = deepFind(await ctx.exec('GOOGLEDRIVE_CREATE_FOLDER', { name: FOLDER }), ['id']);
  if (id) await ctx.saveConfig({ folder_id: id });
  return id;
}

export const googledrive: ProviderActions = {
  upload_file: {
    summary: 'Upload a file into the Pactovio folder',
    run: async (i, ctx) => {
      const f = payload(i, ctx);
      const folder = await driveFolder(ctx);
      const staged = await ctx.stage('GOOGLEDRIVE_UPLOAD_FILE', f);
      const data = await ctx.exec('GOOGLEDRIVE_UPLOAD_FILE', { file_to_upload: staged, ...(folder ? { folder_to_upload_to: folder } : {}) });
      const id = deepFind(data, ['id', 'fileId']);
      return { id, url: deepFind(data, ['webViewLink', 'web_view_link']) ?? (id ? `https://drive.google.com/file/d/${id}/view` : null), details: { folder } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('GOOGLEDRIVE_GET_FILE_METADATA', { fileId: out.id }), ['id']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('GOOGLEDRIVE_DELETE_FILE', { fileId: out.id }); },
    sample: () => SAMPLE,
  },
};

export const dropbox: ProviderActions = {
  upload_file: {
    summary: 'Upload a file into /Pactovio',
    run: async (i, ctx) => {
      const f = payload(i, ctx);
      const staged = await ctx.stage('DROPBOX_UPLOAD_FILE', f);
      const data = await ctx.exec('DROPBOX_UPLOAD_FILE', { path: `/${FOLDER}/${f.filename}`, content: staged, mode: 'add', autorename: true });
      const path = deepFind(data, ['path_display', 'path_lower']) ?? `/${FOLDER}/${f.filename}`;
      return { id: deepFind(data, ['id']) ?? path, url: `https://www.dropbox.com/home${path.split('/').slice(0, -1).join('/')}`, details: { path } };
    },
    readback: async (out, ctx) => !!out.details?.path && deepFind(await ctx.exec('DROPBOX_GET_METADATA', { path: out.details.path }), ['id', 'name']) !== null,
    cleanup: async (out, ctx) => { if (out.details?.path) await ctx.exec('DROPBOX_DELETE_FILE_OR_FOLDER', { path: out.details.path }); },
    sample: () => SAMPLE,
  },
};
