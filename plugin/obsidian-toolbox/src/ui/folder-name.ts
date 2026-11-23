export function validFolderName(name: unknown): name is string {
 return typeof name==='string' && !!name && name===name.trim() && !name.startsWith('.')
  && !/[<>:"/\\|?*]/.test(name) && ![...name].some(character=>character.charCodeAt(0)<32 || character.charCodeAt(0)===127)
  && !name.endsWith('.');
}
