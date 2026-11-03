declare module "*.dat" { const text: string; export default text; }
declare module "@electron/remote" { export const BrowserWindow: unknown; }
declare module 'electron' { export const shell: { openExternal(url: string): Promise<void> }; }
declare module "*.svg" { const svg: string; export default svg; }
